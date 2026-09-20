export function computeFiberSignals(outcome) {
  const wall=Number(outcome.wall_ms??0);const ceiling=Math.max(1,Number(outcome.allocation?.budget?.wall_ms ?? (wall || 1)));
  const wallUtil=Math.min(10,Math.max(0,wall/ceiling));
  return {
    schema:'phase-genuine-signals-v2',
    validated_progress: outcome.passed ? 1 : 0,
    worker_completed: outcome.worker_ok ? 1 : 0,
    validation_passed: outcome.passed ? 1 : 0,
    validation_failed: outcome.passed ? 0 : 1,
    wall_ms: wall,
    wall_budget_ms: ceiling,
    wall_budget_utilization: Number(wallUtil.toFixed(8)),
    wall_budget_remaining_ms: Math.max(0,ceiling-wall),
    allocated_context_tokens: Number(outcome.allocation?.budget?.context_tokens??0),
    allocated_tokens: Number(outcome.allocation?.budget?.tokens??0),
    allocated_tool_calls: Number(outcome.allocation?.budget?.tool_calls??0),
    observed_input_tokens: outcome.observed_input_tokens ?? null,
    observed_output_tokens: outcome.observed_output_tokens ?? null,
    observed_context_misses: outcome.context_misses ?? null,
    observed_retries: outcome.retries ?? null,
    observed_human_requests: outcome.human_requests ?? null,
    note: 'null means unobserved; Phase never coerces unavailable measurements to zero'
  };
}

// Derived hypothesis, never canonical measurement.
export function defaultAllocationObjective(signals) {
  return Number((Number(signals.validated_progress??0) - 0.1*Math.min(1,Number(signals.wall_budget_utilization??0))).toFixed(8));
}
