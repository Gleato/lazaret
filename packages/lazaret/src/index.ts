export {
  type Committer,
  type CommitterOptions,
  createCommitter,
  TransientCommitError,
} from "./commit/committer";
export { signRequest, type VerifyResult, verifyLazaretRequest } from "./commit/sign";
export type { CompiledOverlay } from "./config/define";
export {
  type CompiledRoute,
  DEFAULT_SENSITIVE_FIELDS,
  defineLazaret,
  type LazaretConfig,
  LazaretConfigError,
  type Policy,
  type ResolvedConfig,
  type RouteConfig,
} from "./config/define";
export {
  type BehaviourSample,
  type BehaviourStore,
  MemoryBehaviourStore,
  scoreBehaviour,
} from "./gate/behaviour";
export type { MemoryGateRule } from "./gate/gate";
export { decide, type GateDecision } from "./gate/gate";
export { canonicalize, inspect } from "./gate/inspect";
export {
  type Condition,
  compileRule,
  type FieldRef,
  type Op,
  type Rule,
  type RuleContext,
  RuleError,
} from "./gate/rules";
export { combineRisk, type GateSignal, type SignalSource } from "./gate/signals";
export { SIGNATURES, type Signature } from "./gate/signatures";
export { createGateway, type GatewayDeps } from "./gateway/gateway";
export type { ReviewDispatch, ReviewSnapshot } from "./ledger/durable-object";
export { LazaretLedger } from "./ledger/durable-object";
export type { LedgerEvent, LedgerEventType, StoredEvent } from "./ledger/events";
export { applyEvent, IllegalTransition, initialState, replay } from "./ledger/machine";
export { applyTaint, type TaintResult } from "./ledger/taint";
export { type CycleConfig, DEFAULT_CYCLE } from "./ledger/triggers";
export type * from "./ledger/types";
export {
  AnthropicRuleProposer,
  buildDistillPrompt,
  DISTILL_SYSTEM_PROMPT,
  type DistillResult,
  PROPOSAL_SCHEMA,
  parseProposals,
  type RuleProposer,
  runDistillation,
} from "./memory/distill";
export { backtest, statusAfterBacktest, statusAfterLiveEvidence } from "./memory/lifecycle";
export { archiveRecord, sampleFromEntry } from "./memory/sample";
export {
  type ArchiveInput,
  type DistillInput,
  LazaretMemory,
  type RuleEvent,
} from "./memory/store";
export {
  type ActiveRuleSpec,
  type ArchivedVerdict,
  DEFAULT_MEMORY_THRESHOLDS,
  type JsonValue,
  type MemoryRule,
  type MemoryThresholds,
  type RuleProposal,
  type RuleSample,
  type RuleStatus,
} from "./memory/types";
export { overlayResponse } from "./overlay/apply";
export {
  type BuiltinMerge,
  builtinMerge,
  type MergeContext,
  type MergeFn,
  type OverlayConfig,
  PENDING_MARKER,
  type PendingWrite,
} from "./overlay/merge";
export {
  AnthropicReviewer,
  FatalReviewError,
  type ReviewCall,
  type Reviewer,
  type ReviewOutcome,
  type ReviewTier,
  TransientReviewError,
} from "./review/client";
export { type InlineDecision, inlineReview } from "./review/inline";
export type { MemoryPort } from "./review/pipeline";
export {
  chunkEntries,
  finalVerdict,
  type LedgerPort,
  type PipelineDeps,
  type PipelineResult,
  runReviewPipeline,
  type StepOptions,
  type StepRunner,
} from "./review/pipeline";
export type { MemoryHint } from "./review/prompt";
export {
  buildBatchPrompt,
  buildEscalationPrompt,
  encodeUntrusted,
  SYSTEM_PROMPT,
} from "./review/prompt";
export {
  MalformedReviewError,
  parseVerdicts,
  VERDICT_CATEGORIES,
  VERDICT_SCHEMA,
} from "./review/schema";
export { LazaretReviewWorkflow } from "./review/workflow";
export { compilePattern, matchPattern } from "./routing/matcher";
export { normalizePath } from "./routing/normalize";
