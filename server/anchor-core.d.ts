export interface AnchorRequest {
  method?: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, string>;
  origin: string;
}
export interface AnchorResponse { status: number; type: string; body: string }
export const CORS: Record<string, string>;
export function handle(req: AnchorRequest): Promise<AnchorResponse>;
