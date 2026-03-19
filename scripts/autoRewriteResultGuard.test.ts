import assert from "node:assert/strict";

import {
  finalizeAutoRewriteOutcome,
  shouldKeepAutoRewriteParagraph,
} from "../src/server/autoRewrite/resultGuard.js";

assert.equal(
  shouldKeepAutoRewriteParagraph({ riskBefore: 62, riskAfter: 41 }),
  true,
  "段落风险下降时应保留改写"
);

assert.equal(
  shouldKeepAutoRewriteParagraph({ riskBefore: 62, riskAfter: 62 }),
  false,
  "段落风险不下降时应丢弃改写"
);

assert.deepEqual(
  finalizeAutoRewriteOutcome({
    overallBefore: 38,
    overallAfter: 45,
    keptCount: 3,
  }),
  {
    rollbackApplied: true,
    finalOverallCurrent: 38,
    finalKeptCount: 0,
    keptBeforeRollback: 3,
  },
  "全文分数上升时应整轮回滚"
);

assert.deepEqual(
  finalizeAutoRewriteOutcome({
    overallBefore: 38,
    overallAfter: 31,
    keptCount: 3,
  }),
  {
    rollbackApplied: false,
    finalOverallCurrent: 31,
    finalKeptCount: 3,
    keptBeforeRollback: 0,
  },
  "全文分数下降时应保留本轮有效结果"
);

console.log("autoRewriteResultGuard tests passed");
