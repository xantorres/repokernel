declare module 'picocolors' {
  export interface Colors {
    readonly bold: (value: string) => string;
    readonly dim: (value: string) => string;
    readonly red: (value: string) => string;
    readonly yellow: (value: string) => string;
  }

  const picocolors: Colors;
  export default picocolors;
}
