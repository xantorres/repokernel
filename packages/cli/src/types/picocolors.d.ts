declare module 'picocolors' {
  export interface Colors {
    readonly bold: (value: string) => string;
    readonly dim: (value: string) => string;
    readonly red: (value: string) => string;
    readonly yellow: (value: string) => string;
    readonly green: (value: string) => string;
    readonly cyan: (value: string) => string;
    readonly gray: (value: string) => string;
    readonly white: (value: string) => string;
  }

  const picocolors: Colors;
  export default picocolors;
}
