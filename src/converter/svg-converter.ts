/**
 * SVG Converter for reMarkable strokes
 *
 * Converts parsed .rm file data to SVG format
 */

import { RmPage, Stroke, Point, PenType, Color, Layer } from '../parser/rm-parser';

// reMarkable page dimensions (in points)
const PAGE_WIDTH = 1404;
const PAGE_HEIGHT = 1872;

// Color mapping
const COLOR_MAP: Record<Color, string> = {
    [Color.Black]: '#000000',
    [Color.Grey]: '#808080',
    [Color.White]: '#FFFFFF',
    [Color.Yellow]: '#FFEB3B',
    [Color.Green]: '#4CAF50',
    [Color.Pink]: '#E91E63',
    [Color.Blue]: '#2196F3',
    [Color.Red]: '#F44336',
    [Color.GrayOverlap]: '#A0A0A0',
};

// Pen stroke width multipliers
const PEN_WIDTH_SCALE: Partial<Record<PenType, number>> = {
    [PenType.Ballpoint]: 1.0,
    [PenType.BallpointV2]: 1.0,
    [PenType.Marker]: 2.5,
    [PenType.MarkerV2]: 2.5,
    [PenType.Fineliner]: 0.8,
    [PenType.FinelinerV2]: 0.8,
    [PenType.SharpPencil]: 0.7,
    [PenType.SharpPencilV2]: 0.7,
    [PenType.TiltPencil]: 1.2,
    [PenType.TiltPencilV2]: 1.2,
    [PenType.Brush]: 3.0,
    [PenType.Highlighter]: 15.0,
    [PenType.HighlighterV2]: 15.0,
    [PenType.CalligraphyPen]: 2.0,
};

export interface SvgOptions {
    width?: number;
    height?: number;
    backgroundColor?: string;
    includeBackground?: boolean;
    strokeScale?: number;
}

const DEFAULT_OPTIONS: SvgOptions = {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    backgroundColor: '#FFFFFF',
    includeBackground: true,
    strokeScale: 1.0,
};

/**
 * Convert a single page to SVG
 */
export function pageToSvg(page: RmPage, options: SvgOptions = {}): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const { width, height, backgroundColor, includeBackground, strokeScale } = opts;

    const svgParts: string[] = [];

    // SVG header
    svgParts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}" width="${width}" height="${height}">`
    );

    // Background
    if (includeBackground) {
        svgParts.push(`<rect width="100%" height="100%" fill="${backgroundColor}"/>`);
    }

    // Render each layer
    for (let layerIdx = 0; layerIdx < page.layers.length; layerIdx++) {
        const layer = page.layers[layerIdx];
        svgParts.push(`<g id="layer-${layerIdx}">`);

        for (const stroke of layer.strokes) {
            const strokeSvg = strokeToPath(stroke, strokeScale!);
            if (strokeSvg) {
                svgParts.push(strokeSvg);
            }
        }

        svgParts.push('</g>');
    }

    // Close SVG
    svgParts.push('</svg>');

    return svgParts.join('\n');
}

/**
 * Convert a stroke to an SVG path element
 */
function strokeToPath(stroke: Stroke, scale: number): string | null {
    if (stroke.points.length < 2) {
        return null;
    }

    // Check if this is an eraser - skip it
    if (stroke.penType === PenType.Eraser || stroke.penType === PenType.EraseArea) {
        return null;
    }

    const color = COLOR_MAP[stroke.color] || '#000000';
    const widthScale = PEN_WIDTH_SCALE[stroke.penType] || 1.0;
    const baseWidth = stroke.strokeWidth * widthScale * scale;

    // For highlighter, use semi-transparent fill
    const isHighlighter = stroke.penType === PenType.Highlighter || stroke.penType === PenType.HighlighterV2;
    const opacity = isHighlighter ? 0.3 : 1.0;

    // Build path data
    const pathData = buildPathData(stroke.points);

    // Use variable width if pressure data is available
    const hasVariablePressure = stroke.points.some(p => p.pressure !== stroke.points[0].pressure);

    if (hasVariablePressure && !isHighlighter) {
        // Create variable-width stroke using multiple paths
        return createVariableWidthPath(stroke.points, color, baseWidth, opacity);
    }

    return `<path d="${pathData}" stroke="${color}" stroke-width="${baseWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`;
}

/**
 * Build SVG path data from points
 */
function buildPathData(points: Point[]): string {
    if (points.length === 0) return '';

    const parts: string[] = [];

    // Move to first point
    parts.push(`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`);

    // Use quadratic bezier curves for smoother lines
    if (points.length === 2) {
        parts.push(`L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`);
    } else {
        for (let i = 1; i < points.length - 1; i++) {
            const p0 = points[i - 1];
            const p1 = points[i];
            const p2 = points[i + 1];

            // Calculate control point
            const cx = p1.x;
            const cy = p1.y;

            // End point is midpoint between current and next
            const ex = (p1.x + p2.x) / 2;
            const ey = (p1.y + p2.y) / 2;

            parts.push(`Q ${cx.toFixed(2)} ${cy.toFixed(2)} ${ex.toFixed(2)} ${ey.toFixed(2)}`);
        }

        // Connect to last point
        const last = points[points.length - 1];
        parts.push(`L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`);
    }

    return parts.join(' ');
}

/**
 * Create a variable-width path by generating filled shapes
 */
function createVariableWidthPath(points: Point[], color: string, baseWidth: number, opacity: number): string {
    if (points.length < 2) return '';

    const paths: string[] = [];

    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];

        // Calculate width based on pressure
        const w1 = baseWidth * (0.5 + p1.pressure * 0.5);
        const w2 = baseWidth * (0.5 + p2.pressure * 0.5);

        // Calculate perpendicular direction
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.sqrt(dx * dx + dy * dy);

        if (len < 0.01) continue;

        const nx = -dy / len;
        const ny = dx / len;

        // Create a quadrilateral for this segment
        const x1a = p1.x + nx * w1 / 2;
        const y1a = p1.y + ny * w1 / 2;
        const x1b = p1.x - nx * w1 / 2;
        const y1b = p1.y - ny * w1 / 2;
        const x2a = p2.x + nx * w2 / 2;
        const y2a = p2.y + ny * w2 / 2;
        const x2b = p2.x - nx * w2 / 2;
        const y2b = p2.y - ny * w2 / 2;

        paths.push(
            `M ${x1a.toFixed(2)} ${y1a.toFixed(2)} ` +
            `L ${x2a.toFixed(2)} ${y2a.toFixed(2)} ` +
            `L ${x2b.toFixed(2)} ${y2b.toFixed(2)} ` +
            `L ${x1b.toFixed(2)} ${y1b.toFixed(2)} Z`
        );
    }

    return `<path d="${paths.join(' ')}" fill="${color}" opacity="${opacity}"/>`;
}

/**
 * Convert multiple pages to a single SVG with pages stacked vertically
 */
export function pagesToSvg(pages: RmPage[], options: SvgOptions = {}): string {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    if (pages.length === 0) {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}"></svg>`;
    }

    if (pages.length === 1) {
        return pageToSvg(pages[0], opts);
    }

    const totalHeight = PAGE_HEIGHT * pages.length;
    const svgParts: string[] = [];

    svgParts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE_WIDTH} ${totalHeight}" width="${opts.width}" height="${opts.height! * pages.length}">`
    );

    // Background
    if (opts.includeBackground) {
        svgParts.push(`<rect width="100%" height="100%" fill="${opts.backgroundColor}"/>`);
    }

    // Render each page with offset
    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
        const yOffset = pageIdx * PAGE_HEIGHT;
        svgParts.push(`<g transform="translate(0, ${yOffset})">`);

        const page = pages[pageIdx];
        for (let layerIdx = 0; layerIdx < page.layers.length; layerIdx++) {
            const layer = page.layers[layerIdx];
            for (const stroke of layer.strokes) {
                const strokeSvg = strokeToPath(stroke, opts.strokeScale!);
                if (strokeSvg) {
                    svgParts.push(strokeSvg);
                }
            }
        }

        svgParts.push('</g>');

        // Page separator line
        if (pageIdx < pages.length - 1) {
            svgParts.push(`<line x1="0" y1="${yOffset + PAGE_HEIGHT}" x2="${PAGE_WIDTH}" y2="${yOffset + PAGE_HEIGHT}" stroke="#CCCCCC" stroke-width="2"/>`);
        }
    }

    svgParts.push('</svg>');

    return svgParts.join('\n');
}

/**
 * Get the bounding box of all strokes on a page
 */
export function getPageBounds(page: RmPage): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const layer of page.layers) {
        for (const stroke of layer.strokes) {
            for (const point of stroke.points) {
                minX = Math.min(minX, point.x);
                minY = Math.min(minY, point.y);
                maxX = Math.max(maxX, point.x);
                maxY = Math.max(maxY, point.y);
            }
        }
    }

    return {
        minX: minX === Infinity ? 0 : minX,
        minY: minY === Infinity ? 0 : minY,
        maxX: maxX === -Infinity ? PAGE_WIDTH : maxX,
        maxY: maxY === -Infinity ? PAGE_HEIGHT : maxY,
    };
}

/**
 * Create a cropped SVG that only includes the content area
 */
export function pageToCroppedSvg(page: RmPage, padding: number = 20): string {
    const bounds = getPageBounds(page);

    const width = bounds.maxX - bounds.minX + padding * 2;
    const height = bounds.maxY - bounds.minY + padding * 2;

    const svgParts: string[] = [];

    svgParts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}" width="${width}" height="${height}">`
    );

    svgParts.push(`<rect x="${bounds.minX - padding}" y="${bounds.minY - padding}" width="${width}" height="${height}" fill="white"/>`);

    for (const layer of page.layers) {
        for (const stroke of layer.strokes) {
            const strokeSvg = strokeToPath(stroke, 1.0);
            if (strokeSvg) {
                svgParts.push(strokeSvg);
            }
        }
    }

    svgParts.push('</svg>');

    return svgParts.join('\n');
}
