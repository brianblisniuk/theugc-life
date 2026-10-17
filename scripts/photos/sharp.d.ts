declare module "sharp" {
  interface SharpInstance {
    resize(options: { width: number; withoutEnlargement?: boolean }): SharpInstance;
    webp(options: { quality: number }): SharpInstance;
    toBuffer(): Promise<Buffer>;
    metadata(): Promise<{ width?: number; height?: number }>;
  }
  function sharp(input: Buffer, options?: { failOn?: "none" | "error" }): SharpInstance;
  export default sharp;
}
