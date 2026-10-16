/**
 * The dense board lives in `pipeline-workspace`. This module remains so a
 * stale import of the old eight-column board cannot render `follow_up` as a
 * stage.
 */
export { PipelineDense as PipelineBoard } from "./pipeline-workspace";
