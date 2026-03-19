export function shouldKeepAutoRewriteParagraph(quality?: {
  riskBefore?: number;
  riskAfter?: number;
}): boolean {
  if (!quality) return true;
  if (typeof quality.riskBefore !== "number" || typeof quality.riskAfter !== "number") return true;
  return quality.riskAfter < quality.riskBefore;
}

export function finalizeAutoRewriteOutcome(params: {
  overallBefore: number;
  overallAfter: number;
  keptCount: number;
}) {
  const rollbackApplied = params.keptCount > 0 && params.overallAfter > params.overallBefore;
  return {
    rollbackApplied,
    finalOverallCurrent: rollbackApplied ? params.overallBefore : params.overallAfter,
    finalKeptCount: rollbackApplied ? 0 : params.keptCount,
    keptBeforeRollback: rollbackApplied ? params.keptCount : 0,
  };
}
