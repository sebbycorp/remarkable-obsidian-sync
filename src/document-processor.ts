/**
 * Document Processor
 *
 * Handles extracting and processing reMarkable document archives (ZIP files)
 * containing .rm files, metadata, and other resources.
 */

import JSZip from 'jszip';
import { RmParser, RmPage, extractText } from './parser/rm-parser';
import { pageToSvg, pageToCroppedSvg, SvgOptions } from './converter/svg-converter';

export interface DocumentContent {
    id: string;
    name: string;
    pages: ProcessedPage[];
    metadata: DocumentMeta;
}

export interface ProcessedPage {
    pageNumber: number;
    pageId: string;
    svg: string;
    croppedSvg: string;
    text: string;
    hasContent: boolean;
}

export interface DocumentMeta {
    visibleName: string;
    lastModified: string;
    parent: string;
    type: string;
    version: number;
    pageCount: number;
}

export interface ContentMetadata {
    fileType: string;
    pageCount: number;
    pages: string[];
    documentMetadata?: Record<string, unknown>;
}

/**
 * Process a reMarkable document ZIP file
 */
export async function processDocumentZip(
    zipData: ArrayBuffer,
    documentId: string,
    svgOptions?: SvgOptions
): Promise<DocumentContent> {
    const zip = await JSZip.loadAsync(zipData);

    // Read content metadata
    const contentFile = zip.file(`${documentId}.content`);
    let contentMeta: ContentMetadata | null = null;

    if (contentFile) {
        const contentJson = await contentFile.async('string');
        contentMeta = JSON.parse(contentJson);
    }

    // Read document metadata
    const metadataFile = zip.file(`${documentId}.metadata`);
    let docMeta: DocumentMeta = {
        visibleName: 'Untitled',
        lastModified: new Date().toISOString(),
        parent: '',
        type: 'DocumentType',
        version: 1,
        pageCount: 0,
    };

    if (metadataFile) {
        const metaJson = await metadataFile.async('string');
        const parsed = JSON.parse(metaJson);
        docMeta = {
            ...docMeta,
            ...parsed,
        };
    }

    // Get page order from content metadata or find .rm files
    let pageIds: string[] = [];

    if (contentMeta?.pages && contentMeta.pages.length > 0) {
        pageIds = contentMeta.pages;
    } else {
        // Find all .rm files in the zip
        const rmFiles = Object.keys(zip.files).filter(
            name => name.endsWith('.rm') && !name.includes('/')
        );
        pageIds = rmFiles.map(name => name.replace('.rm', ''));
    }

    docMeta.pageCount = pageIds.length;

    // Process each page
    const processedPages: ProcessedPage[] = [];

    for (let i = 0; i < pageIds.length; i++) {
        const pageId = pageIds[i];
        const rmFile = zip.file(`${documentId}/${pageId}.rm`) || zip.file(`${pageId}.rm`);

        if (rmFile) {
            try {
                const rmData = await rmFile.async('arraybuffer');
                const parser = new RmParser(rmData);
                const page = parser.parse();

                const hasContent = page.layers.some(l => l.strokes.length > 0) || page.textItems.length > 0;

                processedPages.push({
                    pageNumber: i + 1,
                    pageId,
                    svg: pageToSvg(page, svgOptions),
                    croppedSvg: hasContent ? pageToCroppedSvg(page) : '',
                    text: extractText([page]),
                    hasContent,
                });
            } catch (error) {
                console.warn(`Failed to parse page ${pageId}:`, error);
                // Add empty page placeholder
                processedPages.push({
                    pageNumber: i + 1,
                    pageId,
                    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1404 1872"></svg>',
                    croppedSvg: '',
                    text: '',
                    hasContent: false,
                });
            }
        }
    }

    return {
        id: documentId,
        name: docMeta.visibleName,
        pages: processedPages,
        metadata: docMeta,
    };
}

/**
 * Generate Markdown output for a processed document
 */
export function documentToMarkdown(doc: DocumentContent, includeImages: boolean = true): string {
    const lines: string[] = [];

    // Frontmatter
    lines.push('---');
    lines.push(`title: "${doc.name}"`);
    lines.push(`remarkable_id: "${doc.id}"`);
    lines.push(`last_modified: "${doc.metadata.lastModified}"`);
    lines.push(`page_count: ${doc.metadata.pageCount}`);
    lines.push('---');
    lines.push('');

    // Title
    lines.push(`# ${doc.name}`);
    lines.push('');

    // Pages
    for (const page of doc.pages) {
        if (!page.hasContent) continue;

        lines.push(`## Page ${page.pageNumber}`);
        lines.push('');

        // Include text content if available
        if (page.text.trim()) {
            lines.push(page.text);
            lines.push('');
        }

        // Include image placeholder
        if (includeImages) {
            const imageName = `${doc.id}-page-${page.pageNumber}.svg`;
            lines.push(`![[${imageName}]]`);
            lines.push('');
        }
    }

    return lines.join('\n');
}

/**
 * Extract just the SVG files from a document
 */
export function extractSvgFiles(doc: DocumentContent, cropped: boolean = false): Map<string, string> {
    const files = new Map<string, string>();

    for (const page of doc.pages) {
        if (!page.hasContent) continue;

        const fileName = `${doc.id}-page-${page.pageNumber}.svg`;
        const svg = cropped ? page.croppedSvg : page.svg;

        if (svg) {
            files.set(fileName, svg);
        }
    }

    return files;
}

/**
 * Get a summary of document content
 */
export function getDocumentSummary(doc: DocumentContent): string {
    const pagesWithContent = doc.pages.filter(p => p.hasContent).length;
    const totalText = doc.pages.reduce((acc, p) => acc + p.text.length, 0);

    return `${doc.name}: ${pagesWithContent}/${doc.metadata.pageCount} pages with content, ${totalText} characters of text`;
}
