export interface ProblemDetails {
  type: string;
  title: string;
  status?: number;
  detail: string;
  instance?: string;
  xyteCode: string;
  retriable: boolean;
  upstream?: unknown;
  cause?: string;
  suggestedCommands?: string[];
}
