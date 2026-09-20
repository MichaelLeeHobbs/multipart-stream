declare module 'streamsearch' {
  export default class StreamSearch {
    constructor(
      needle: Buffer | string,
      callback: (
        matched: boolean,
        data: Buffer | undefined,
        start: number,
        end: number,
        safe: boolean,
      ) => void,
    );
    push(chunk: Buffer): number;
    destroy(): void;
  }
}
