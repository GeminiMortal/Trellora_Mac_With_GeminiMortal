declare module 'word-extractor' {
  interface Document {
    getBody(): string;
    getHeaders(): string;
    getFooters(): string;
    getAnnotations(): string;
    getTextBoxes(): string;
    getFootnotes(): string;
    getEndnotes(): string;
    getComments(): string;
  }

  class WordExtractor {
    extract(file: string | Buffer): Promise<Document>;
  }

  export = WordExtractor;
}