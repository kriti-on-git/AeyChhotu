import type { Request, Response } from "express";

/* Terminal 404 handler: any request that fell through the router gets the
   contract error envelope (docs/7-api-contract.md §1.1). */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.originalUrl} does not exist.`,
    },
  });
}
