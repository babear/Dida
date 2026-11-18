// 过程断言：判定链的第三面（ADR-0005 / ADR-0014）。只读调用日志里解析后的 argv 数组，
// 不读轨迹、不读终态快照——轨迹只服务可信度检查，快照只服务结局断言。
//
// 规则表是**凭证据准入**的：每条规则都对应一次真实会话确认过的缺陷动作，
// 不凭缺陷描述反推。当前表为空，因为仓库里还没有第一条真实 scenario 跑出过证据。
// 往里加一条之前，先跑一次真实会话，再把 discoveredBy 指向暴露它的那条用例。
//
// 只管「已确认的缺陷动作」，不管「绕没绕远路」这类通用质量判断——
// 后者归判定 agent 写进报告，不影响通过或失败（ADR-0005）。
export const PROCESS_RULES = [];

// 规则形状：
//   id           稳定标识，报告与提醒里点名用
//   desc         一句话说清禁止什么，直接当失败项的 name
//   discoveredBy 暴露这条规则的那条 scenario id（证据来源，可追溯）
//   check        (entries) => { ok, expected?, actual }
//                entries 是本次 run 的调用日志里能解析的条目，带 index（原始行序）
// 规则的 check 是我们自己的代码，它抛异常或返回非法形状都是 harness 的缺陷。
// 折成 threw 而不是普通的「没通过」——上层据此判 broken（去修 harness），
// 判 failed 会让报告叫人不该改的 skill（ADR-0005 的 2026-11-18 补充）。
// 返回值的口径与结局断言一致：必须是带布尔 ok 的对象，别的都算写错了。
function runRule(rule, entries) {
  let result;
  try {
    result = rule.check(entries);
  } catch (error) {
    return {
      ok: false,
      threw: true,
      name: rule.desc,
      expected: '规则能判出结论',
      actual: `规则自己抛了异常：${error.message}`,
    };
  }
  if (!result || typeof result.ok !== 'boolean') {
    return {
      ok: false,
      threw: true,
      name: rule.desc,
      expected: '带布尔 ok 的对象',
      actual: result === undefined ? 'undefined' : JSON.stringify(result),
    };
  }
  return {
    ok: result.ok,
    name: rule.desc,
    expected: result.expected ?? '没有出现',
    actual: result.actual ?? (result.ok ? '没有出现' : '出现了'),
  };
}

// 返回 { ok, threw, results }。results 与结局断言同形（{ok, name, expected, actual}），
// 报告与控制台复用现成的渲染，不另写一套。
// threw 与 ok 分开给：一条规则写错了，整面就该判 broken，而不是「过程断言没通过」。
export function evaluateProcessRules(calls, rules = PROCESS_RULES) {
  const entries = (calls ?? [])
    .map((call, index) => (call?.unparseable ? null : { ...call, index }))
    .filter(Boolean);
  const results = rules.map((rule) => runRule(rule, entries));
  return {
    ok: results.every((result) => result.ok),
    threw: results.some((result) => result.threw),
    results: results.map(({ threw: _ignored, ...result }) => result),
  };
}

// 规则的证据来源是可追溯的：discoveredBy 指向的用例被删掉或被改名之后，
// 这条规则就失去了「当初确认真实发生过」的凭据。全量运行时提醒，不判失败——
// 它说明流程没走完，不是哪条用例没通过（与 probes/ 残留提醒同类）。
export function staleRuleSources(rules, scenarioIds) {
  const known = new Set(scenarioIds ?? []);
  return rules.filter((rule) => !rule.discoveredBy || !known.has(rule.discoveredBy));
}
