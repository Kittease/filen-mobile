package io.filen.rawimageconverter

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.Bitmap
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile

class NoEmbeddedPreviewException :
    CodedException("NO_EMBEDDED_PREVIEW", "No embedded JPEG preview found in RAW file", null)

class FileReadException(path: String, cause: Throwable?) :
    CodedException("FILE_READ_ERROR", "Failed to read file: $path", cause)

class RawImageConverterModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("RawImageConverter")

        AsyncFunction("extractRawPreview") { inputPath: String, outputPath: String ->
            extractLargestJpeg(inputPath, outputPath)
        }
    }

    private fun getExifRotation(file: File): Float {
        return try {
            val exif = ExifInterface(file.absolutePath)

            orientationToRotation(exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL))
        } catch (_: Exception) {
            0f
        }
    }

    /**
     * Scan the first portion of a file for a TIFF IFD orientation tag.
     * Works with CR3 and other formats where ExifInterface may not parse the container.
     */
    private fun scanForOrientation(file: File): Float {
        return try {
            val raf = RandomAccessFile(file, "r")

            try {
                val scanSize = minOf(65536L, raf.length()).toInt()
                val buf = ByteArray(scanSize)

                raf.readFully(buf, 0, scanSize)

                // Look for TIFF header (II = little-endian, MM = big-endian)
                for (i in 0 until scanSize - 2) {
                    val isTiffLE = buf[i] == 0x49.toByte() && buf[i + 1] == 0x49.toByte()
                    val isTiffBE = buf[i] == 0x4D.toByte() && buf[i + 1] == 0x4D.toByte()

                    if (!isTiffLE && !isTiffBE) continue
                    if (i + 4 > scanSize) continue

                    // Verify TIFF magic number (42)
                    val magic = if (isTiffLE) {
                        (buf[i + 2].toInt() and 0xFF) or ((buf[i + 3].toInt() and 0xFF) shl 8)
                    } else {
                        ((buf[i + 2].toInt() and 0xFF) shl 8) or (buf[i + 3].toInt() and 0xFF)
                    }

                    if (magic != 42) continue

                    // Read IFD0 offset
                    val ifdOffset = if (isTiffLE) {
                        readU32LE(buf, i + 4)
                    } else {
                        readU32BE(buf, i + 4)
                    }

                    val absIfdOffset = i + ifdOffset.toInt()

                    if (absIfdOffset + 2 > scanSize) continue

                    val numEntries = if (isTiffLE) {
                        readU16LE(buf, absIfdOffset)
                    } else {
                        readU16BE(buf, absIfdOffset)
                    }

                    for (e in 0 until numEntries) {
                        val entryOffset = absIfdOffset + 2 + e * 12

                        if (entryOffset + 12 > scanSize) break

                        val tag = if (isTiffLE) readU16LE(buf, entryOffset) else readU16BE(buf, entryOffset)

                        // 0x0112 = Orientation tag
                        if (tag == 0x0112) {
                            val value = if (isTiffLE) readU16LE(buf, entryOffset + 8) else readU16BE(buf, entryOffset + 8)

                            return orientationToRotation(value)
                        }
                    }
                }

                0f
            } finally {
                raf.close()
            }
        } catch (_: Exception) {
            0f
        }
    }

    private fun readU16LE(buf: ByteArray, offset: Int): Int =
        (buf[offset].toInt() and 0xFF) or ((buf[offset + 1].toInt() and 0xFF) shl 8)

    private fun readU16BE(buf: ByteArray, offset: Int): Int =
        ((buf[offset].toInt() and 0xFF) shl 8) or (buf[offset + 1].toInt() and 0xFF)

    private fun readU32LE(buf: ByteArray, offset: Int): Long =
        (buf[offset].toLong() and 0xFF) or
        ((buf[offset + 1].toLong() and 0xFF) shl 8) or
        ((buf[offset + 2].toLong() and 0xFF) shl 16) or
        ((buf[offset + 3].toLong() and 0xFF) shl 24)

    private fun readU32BE(buf: ByteArray, offset: Int): Long =
        ((buf[offset].toLong() and 0xFF) shl 24) or
        ((buf[offset + 1].toLong() and 0xFF) shl 16) or
        ((buf[offset + 2].toLong() and 0xFF) shl 8) or
        (buf[offset + 3].toLong() and 0xFF)

    private fun orientationToRotation(orientation: Int): Float {
        return when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
    }

    /**
     * DNG files can be decoded natively by Android's BitmapFactory (API 24+).
     * This gives a full-resolution result instead of a small embedded thumbnail.
     */
    private fun decodeDngNatively(inputPath: String, outputPath: String): Boolean {
        if (!inputPath.lowercase().endsWith(".dng")) return false

        return try {
            val options = BitmapFactory.Options().apply {
                // Subsample to avoid OOM on very large DNG files
                inSampleSize = 1
            }

            // First, just decode bounds to decide on sample size
            val boundsOptions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(inputPath, boundsOptions)

            if (boundsOptions.outWidth <= 0 || boundsOptions.outHeight <= 0) return false

            // Subsample if the image is very large (>4096 on either dimension)
            val maxDim = maxOf(boundsOptions.outWidth, boundsOptions.outHeight)
            if (maxDim > 4096) {
                var sampleSize = 1
                while (maxDim / sampleSize > 4096) {
                    sampleSize *= 2
                }
                options.inSampleSize = sampleSize
            }

            val bitmap = BitmapFactory.decodeFile(inputPath, options) ?: return false

            try {
                val file = File(inputPath)
                val rotation = getExifRotation(file).let {
                    if (it != 0f) it else scanForOrientation(file)
                }

                val outFile = File(outputPath)
                outFile.parentFile?.mkdirs()

                if (rotation != 0f) {
                    val matrix = Matrix().apply { postRotate(rotation) }
                    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)

                    FileOutputStream(outFile).use { fos ->
                        rotated.compress(Bitmap.CompressFormat.JPEG, 95, fos)
                    }

                    if (rotated !== bitmap) {
                        rotated.recycle()
                    }
                } else {
                    FileOutputStream(outFile).use { fos ->
                        bitmap.compress(Bitmap.CompressFormat.JPEG, 95, fos)
                    }
                }

                true
            } finally {
                bitmap.recycle()
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun extractLargestJpeg(inputPath: String, outputPath: String) {
        val file = File(inputPath)
        if (!file.exists()) {
            throw FileReadException(inputPath, null)
        }

        // For DNG files, try native decoding first (full resolution)
        if (decodeDngNatively(inputPath, outputPath)) {
            return
        }

        val raf = try {
            RandomAccessFile(file, "r")
        } catch (e: Exception) {
            throw FileReadException(inputPath, e)
        }

        try {
            val fileLength = raf.length()
            if (fileLength < 4) {
                throw NoEmbeddedPreviewException()
            }

            var bestOffset = -1L
            var bestSize = 0L
            var currentJpegStart = -1L
            var pos = 0L

            val bufferSize = 65536
            val buffer = ByteArray(bufferSize)
            // Keep one byte of overlap to detect markers split across buffer boundaries
            var prevByte: Int = -1

            while (pos < fileLength) {
                val toRead = minOf(bufferSize.toLong(), fileLength - pos).toInt()
                raf.seek(pos)
                val bytesRead = raf.read(buffer, 0, toRead)
                if (bytesRead <= 0) break

                for (i in 0 until bytesRead) {
                    val currentByte = buffer[i].toInt() and 0xFF

                    if (prevByte == 0xFF) {
                        when (currentByte) {
                            0xD8 -> {
                                // JPEG SOI marker — start of a new JPEG
                                currentJpegStart = pos + i - 1
                            }
                            0xD9 -> {
                                // JPEG EOI marker — end of current JPEG
                                if (currentJpegStart >= 0) {
                                    val jpegEnd = pos + i + 1
                                    val jpegSize = jpegEnd - currentJpegStart
                                    if (jpegSize > bestSize) {
                                        bestOffset = currentJpegStart
                                        bestSize = jpegSize
                                    }
                                    currentJpegStart = -1
                                }
                            }
                        }
                    }

                    prevByte = currentByte
                }

                pos += bytesRead
            }

            if (bestOffset < 0 || bestSize < 100) {
                throw NoEmbeddedPreviewException()
            }

            // Write the largest JPEG to a temp file first
            val outFile = File(outputPath)
            outFile.parentFile?.mkdirs()

            val tempFile = File(outputPath + ".tmp")

            raf.seek(bestOffset)
            FileOutputStream(tempFile).use { fos ->
                val copyBuffer = ByteArray(65536)
                var remaining = bestSize
                while (remaining > 0) {
                    val toReadNow = minOf(copyBuffer.size.toLong(), remaining).toInt()
                    val read = raf.read(copyBuffer, 0, toReadNow)
                    if (read <= 0) break
                    fos.write(copyBuffer, 0, read)
                    remaining -= read
                }
            }

            // Apply EXIF rotation — try ExifInterface on RAW, then byte-level scan for CR3/etc,
            // then fall back to the extracted JPEG preview
            val rotation = getExifRotation(file).let {
                if (it != 0f) it else scanForOrientation(file)
            }.let {
                if (it != 0f) it else getExifRotation(tempFile)
            }

            if (rotation != 0f) {
                val original = BitmapFactory.decodeFile(tempFile.absolutePath)

                if (original != null) {
                    val matrix = Matrix().apply { postRotate(rotation) }
                    val rotated = Bitmap.createBitmap(original, 0, 0, original.width, original.height, matrix, true)

                    FileOutputStream(outFile).use { fos ->
                        rotated.compress(Bitmap.CompressFormat.JPEG, 95, fos)
                    }

                    if (rotated !== original) {
                        rotated.recycle()
                    }

                    original.recycle()
                    tempFile.delete()
                } else {
                    tempFile.renameTo(outFile)
                }
            } else {
                tempFile.renameTo(outFile)
            }
        } finally {
            raf.close()
        }
    }
}
