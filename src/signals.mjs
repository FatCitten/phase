export function computeFiberSignals(outcome) {
  const wall=Number(outcome.wall_ms??0);const ceiling=Math.max(1,Number(outcome.allocation?.budget?.wall_ms ?? (wall || 1)));
  const wallUtil=Math.min(10,Math.max(0,wall/ceiling));
  return {
    schema:'phase-genuine-signals-v1',
    validated_progress: outcome.passed ? 1 : 0,
    worker_completed: outcome.worker_ok ? 1 : 0,
    validation_passed: outcome.passed ? 1 : 0,
    validation_failed: outcome.passed ? 0 : 1,
    wall_ms: wall,
    wall_budget_ms: ceiling,
    wall_budget_utilization: Number(wallUtil.toFixed(8)),
    wall_budget_remaining_ms: Math.max(0,ceiling-wall),
    allocated_context_tokens: Number(outcome.allocation?.budget?.context_tokens??0),
    allocated_tool_calls: Number(outcome.allocation?.budget?.tool_calls??0)
  };
}

// Objective is deliberately separate from raw signals so experiments can change it.
export function defaultAllocationObjective(signals) {
  return Number((signals.validated_progress - 0.1*Math.min(1,signals.wall_budget_utilization)).toFixed(8));
}
