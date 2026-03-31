import RawImageConverterModule from "./src/RawImageConverterModule"

/**
 * Extracts the largest embedded JPEG preview from a RAW photo file.
 * Works with CR2, CR3, DNG, NEF, ARW, RAF, ORF, RW2, PEF, SRW and other RAW formats.
 *
 * @param inputPath - Absolute path to the local RAW file
 * @param outputPath - Absolute path where the extracted JPEG will be written
 * @throws If no embedded JPEG is found or file cannot be read
 */
export function extractRawPreview(inputPath: string, outputPath: string): Promise<void> {
	return RawImageConverterModule.extractRawPreview(inputPath, outputPath)
}
