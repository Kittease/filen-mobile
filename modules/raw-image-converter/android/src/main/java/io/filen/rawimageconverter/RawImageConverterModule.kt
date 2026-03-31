package io.filen.rawimageconverter

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.exception.CodedException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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
            withContext(Dispatchers.IO) {
                extractLargestJpeg(inputPath, outputPath)
            }
        }
    }

    private fun extractLargestJpeg(inputPath: String, outputPath: String) {
        val file = File(inputPath)
        if (!file.exists()) {
            throw FileReadException(inputPath, null)
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

            // Write the largest JPEG to the output file
            val outFile = File(outputPath)
            outFile.parentFile?.mkdirs()

            raf.seek(bestOffset)
            FileOutputStream(outFile).use { fos ->
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
        } finally {
            raf.close()
        }
    }
}
