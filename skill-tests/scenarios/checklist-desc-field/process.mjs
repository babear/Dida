// 依据 2026-11-17 的 5 条真实运行记录（01-19-59-761Z-5a5b0b、01-25-37-814Z-7ed8fa、
// 01-39-06-786Z-c2fb33、02-03-06-249Z-553087、02-05-30-123Z-bfa119，均为
// scenario=checklist-desc-field）。其中一次的原样调用序列存在
// evidence/string-array-items-2026-11-17T01-25-37-814Z-7ed8fa.ndjson，
// process.test.mjs 直接拿它当夹具——证据与测试同源，不会各自漂移。
//
// 当时的过程：
//
//   task create ... --items '["帐篷、睡袋、防潮垫",...]'    ← 字符串数组
//   task update <id> --items '帐篷、睡袋、防潮垫,...'        ← 改用逗号分隔再补一次
//
// 5 次全部如此。spec 的「先行验证过的事实」写明：字符串数组会被逐项丢弃并告警，
// 任务落成 TEXT 且 items 为空——也就是说 agent 第一次建的是空任务，正确做法是
// 一开始就用逗号分隔（或对象数组）建完。
//
// 这条规则只禁止「先建错的再 update 补正」这个动作，不要求 agent 走某一条固定路径：
// 直接一次建对、或先读文档再建，都不会命中。
const ITEMS_FLAG = '--items';

function commandPath(argv) {
  return argv?.slice(0, 2).join(' ') ?? '';
}

// 取选项值：`--items v` 与 `--items=v` 两种写法都要认。
function flagValue(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) return argv[i + 1] ?? null;
    if (argv[i].startsWith(`${flag}=`)) return argv[i].slice(flag.length + 1);
  }
  return null;
}

// 字符串数组：以 [ 开头，数组里每一项都是字符串。这是会被丢弃的那种写法。
// 对象数组 [{"title":...}] 是正确写法之一，不算错。
function isStringArrayItems(value) {
  if (typeof value !== 'string' || !value.trim().startsWith('[')) return false;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'string');
}

// 调用日志里只认能解析的条目（坏行没有 argv）。
function entriesOf(calls) {
  return (calls ?? [])
    .filter((call) => call && !call.unparseable && Array.isArray(call.argv))
    .map((call, index) => ({ argv: call.argv, index }));
}

export default function processAssert({ calls }) {
  const entries = entriesOf(calls);

  // 找第一次用字符串数组 --items 建的任务。
  const wrongCreate = entries.find(
    (entry) => commandPath(entry.argv) === 'task create' && isStringArrayItems(flagValue(entry.argv, ITEMS_FLAG)),
  );

  const results = [{
    ok: !wrongCreate,
    name: '不存在「用字符串数组 --items 建任务、再 update 补正」的动作',
    expected: '一次用逗号分隔或对象数组建对检查事项',
    actual: wrongCreate
      ? `第 ${wrongCreate.index + 1} 条调用用了字符串数组形式的 --items，会被逐项丢弃`
      : '没有出现',
  }];

  if (!wrongCreate) return results;

  // 它建出来的任务后来有没有再用 update --items 补一次？有的话就是完整的那条绕路序列。
  const patched = entries.find(
    (entry) => entry.index > wrongCreate.index
      && commandPath(entry.argv) === 'task update'
      && flagValue(entry.argv, ITEMS_FLAG) !== null,
  );
  results.push({
    ok: !patched,
    name: '没有靠 update --items 事后补正',
    expected: '没有出现',
    actual: patched
      ? `第 ${patched.index + 1} 条调用了 update --items 补正`
      : '没有出现',
  });
  return results;
}
