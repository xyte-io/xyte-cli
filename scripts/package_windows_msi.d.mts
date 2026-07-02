export interface WindowsPackagingArgs {
  outDir: string;
  nodeVersion: string;
  skipBuild: boolean;
  skipMsi: boolean;
  skipNode: boolean;
  skipNpmInstall: boolean;
}

export declare function parseArgs(argv: string[]): WindowsPackagingArgs;
export declare function validateArgs(args: WindowsPackagingArgs): void;
export declare function findExpectedSha256(shasumsText: string, fileName: string): string | undefined;
