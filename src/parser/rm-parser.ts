/**
 * reMarkable .rm File Parser (v6 format)
 *
 * Parses the binary .rm file format used by reMarkable tablets
 * running firmware 3.0+ (v6 format).
 *
 * Based on reverse-engineered specifications from:
 * - https://github.com/YakBarber/remarkable_file_format
 * - https://github.com/ricklupton/rmscene
 */

// Pen types used by reMarkable
export enum PenType {
    Ballpoint = 2,
    BallpointV2 = 15,
    Marker = 3,
    MarkerV2 = 16,
    Fineliner = 4,
    FinelinerV2 = 17,
    SharpPencil = 7,
    SharpPencilV2 = 13,
    TiltPencil = 1,
    TiltPencilV2 = 14,
    Brush = 12,
    Highlighter = 5,
    HighlighterV2 = 18,
    Eraser = 6,
    EraseArea = 8,
    CalligraphyPen = 21,
}

// Colors
export enum Color {
    Black = 0,
    Grey = 1,
    White = 2,
    Yellow = 3,
    Green = 4,
    Pink = 5,
    Blue = 6,
    Red = 7,
    GrayOverlap = 8,
}

export interface Point {
    x: number;
    y: number;
    pressure: number;
    tilt: number;
    speed: number;
}

export interface Stroke {
    penType: PenType;
    color: Color;
    strokeWidth: number;
    points: Point[];
}

export interface Layer {
    strokes: Stroke[];
}

export interface TextItem {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface RmPage {
    layers: Layer[];
    textItems: TextItem[];
}

export class RmParser {
    private buffer: DataView;
    private offset: number = 0;
    private version: number = 0;

    constructor(data: ArrayBuffer) {
        this.buffer = new DataView(data);
    }

    /**
     * Parse the .rm file and return page data
     */
    parse(): RmPage {
        // Check header
        const header = this.readString(43);

        if (header.startsWith('reMarkable .lines file, version=')) {
            this.version = parseInt(header.split('=')[1]);
        } else if (header.startsWith('reMarkable lines with selections')) {
            // v6 format header
            this.version = 6;
        } else {
            // Try to detect v6 format by looking for block structure
            this.offset = 0;
            this.version = 6;
        }

        if (this.version === 6) {
            return this.parseV6();
        } else if (this.version >= 3 && this.version <= 5) {
            return this.parseV5();
        } else {
            throw new Error(`Unsupported .rm file version: ${this.version}`);
        }
    }

    /**
     * Parse v6 format (reMarkable firmware 3.0+)
     * This format uses a block-based structure with CRDT sequences
     */
    private parseV6(): RmPage {
        const page: RmPage = {
            layers: [],
            textItems: [],
        };

        // Reset to start
        this.offset = 0;

        // Skip header magic bytes if present
        const magic = this.peekBytes(10);
        if (this.isV6Header(magic)) {
            this.offset = 10; // Skip past header
        }

        // Parse blocks until end of file
        while (this.offset < this.buffer.byteLength - 4) {
            try {
                const block = this.parseBlock();
                if (block) {
                    if (block.type === 'stroke') {
                        // Ensure we have at least one layer
                        if (page.layers.length === 0) {
                            page.layers.push({ strokes: [] });
                        }
                        page.layers[page.layers.length - 1].strokes.push(block.data as Stroke);
                    } else if (block.type === 'text') {
                        page.textItems.push(block.data as TextItem);
                    } else if (block.type === 'layer') {
                        page.layers.push({ strokes: [] });
                    }
                }
            } catch {
                // End of parseable data or corrupted block
                break;
            }
        }

        // If no layers were found, create one empty layer
        if (page.layers.length === 0) {
            page.layers.push({ strokes: [] });
        }

        return page;
    }

    private isV6Header(bytes: Uint8Array): boolean {
        // Check for common v6 header patterns
        const headerStr = String.fromCharCode(...bytes);
        return headerStr.includes('reMarkable') || bytes[0] === 0x72; // 'r'
    }

    private peekBytes(count: number): Uint8Array {
        const bytes = new Uint8Array(count);
        for (let i = 0; i < count && this.offset + i < this.buffer.byteLength; i++) {
            bytes[i] = this.buffer.getUint8(this.offset + i);
        }
        return bytes;
    }

    private parseBlock(): { type: string; data: Stroke | TextItem | null } | null {
        if (this.offset >= this.buffer.byteLength - 4) {
            return null;
        }

        // Try to read block header
        const blockType = this.readUint8();

        // Block type indicators (from reverse engineering)
        switch (blockType) {
            case 0x05: // Stroke data
                return this.parseStrokeBlock();
            case 0x06: // Text block
                return this.parseTextBlock();
            case 0x09: // Layer marker
                return { type: 'layer', data: null };
            default:
                // Skip unknown block - try to find next valid block
                return null;
        }
    }

    private parseStrokeBlock(): { type: 'stroke'; data: Stroke } | null {
        try {
            const penType = this.readUint32() as PenType;
            const color = this.readUint32() as Color;
            const strokeWidth = this.readFloat32();
            const numPoints = this.readUint32();

            if (numPoints > 100000 || numPoints < 0) {
                // Sanity check - probably misaligned
                return null;
            }

            const points: Point[] = [];
            for (let i = 0; i < numPoints; i++) {
                points.push({
                    x: this.readFloat32(),
                    y: this.readFloat32(),
                    pressure: this.readFloat32(),
                    tilt: this.readFloat32(),
                    speed: this.readFloat32(),
                });
            }

            return {
                type: 'stroke',
                data: {
                    penType,
                    color,
                    strokeWidth,
                    points,
                },
            };
        } catch {
            return null;
        }
    }

    private parseTextBlock(): { type: 'text'; data: TextItem } | null {
        try {
            const x = this.readFloat32();
            const y = this.readFloat32();
            const width = this.readFloat32();
            const height = this.readFloat32();
            const textLength = this.readUint32();

            if (textLength > 100000 || textLength < 0) {
                return null;
            }

            const text = this.readString(textLength);

            return {
                type: 'text',
                data: { text, x, y, width, height },
            };
        } catch {
            return null;
        }
    }

    /**
     * Parse v3-v5 format (older reMarkable firmware)
     */
    private parseV5(): RmPage {
        const page: RmPage = {
            layers: [],
            textItems: [],
        };

        // After header, read number of layers
        const numLayers = this.readUint32();

        for (let layerIdx = 0; layerIdx < numLayers; layerIdx++) {
            const layer: Layer = { strokes: [] };
            const numStrokes = this.readUint32();

            for (let strokeIdx = 0; strokeIdx < numStrokes; strokeIdx++) {
                const penType = this.readUint32() as PenType;
                const color = this.readUint32() as Color;

                // Skip unknown field
                this.readUint32();

                const strokeWidth = this.readFloat32();

                // Skip unknown field
                this.readFloat32();

                const numPoints = this.readUint32();
                const points: Point[] = [];

                for (let pointIdx = 0; pointIdx < numPoints; pointIdx++) {
                    points.push({
                        x: this.readFloat32(),
                        y: this.readFloat32(),
                        speed: this.readFloat32(),
                        tilt: this.readFloat32(),
                        // Width/pressure depends on pen type
                        pressure: this.readFloat32(),
                    });

                    // Skip additional point data for some versions
                    if (this.version >= 5) {
                        this.readFloat32(); // direction/rotation
                    }
                }

                layer.strokes.push({
                    penType,
                    color,
                    strokeWidth,
                    points,
                });
            }

            page.layers.push(layer);
        }

        return page;
    }

    // Helper methods for reading binary data
    private readUint8(): number {
        const value = this.buffer.getUint8(this.offset);
        this.offset += 1;
        return value;
    }

    private readUint32(): number {
        const value = this.buffer.getUint32(this.offset, true); // Little-endian
        this.offset += 4;
        return value;
    }

    private readFloat32(): number {
        const value = this.buffer.getFloat32(this.offset, true); // Little-endian
        this.offset += 4;
        return value;
    }

    private readString(length: number): string {
        let str = '';
        for (let i = 0; i < length; i++) {
            const byte = this.buffer.getUint8(this.offset + i);
            if (byte === 0) break;
            str += String.fromCharCode(byte);
        }
        this.offset += length;
        return str;
    }
}

/**
 * Extract text content from parsed pages
 */
export function extractText(pages: RmPage[]): string {
    const textParts: string[] = [];

    for (const page of pages) {
        for (const textItem of page.textItems) {
            if (textItem.text.trim()) {
                textParts.push(textItem.text);
            }
        }
    }

    return textParts.join('\n\n');
}
