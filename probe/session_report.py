import json, glob, os, sys

def schema_chars(path):
    """读 session 文件第一条 system 消息，返回 (工具数, schema 总字符, 名称列表)。"""
    rows = [json.loads(l) for l in open(path, encoding="utf-8", errors="ignore")]
    for d in rows:
        if d.get("type") == "message" and d["message"].get("role") == "system":
            tools = d["message"].get("toolsAdded") or []
            total = sum(len(json.dumps(t, ensure_ascii=False)) for t in tools)
            secs = d["message"].get("sections") or {}
            sect = sum(len(json.dumps(v, ensure_ascii=False)) for v in secs.values())
            return len(tools), total, sect, [t["name"] for t in tools]
    return 0, 0, 0, []

def newest(d):
    fs = sorted(glob.glob(os.path.join(d, "**", "*.jsonl"), recursive=True), key=os.path.getmtime)
    return fs[-1] if fs else None

for label, d in [(a, b) for a, b in zip(sys.argv[1::2], sys.argv[2::2])]:
    f = newest(d)
    if not f:
        print(f"{label}: 没有 session 文件 {d}")
        continue
    n, chars, sect, names = schema_chars(f)
    print(f"{label}: 工具 {n} 个 | 工具 schema {chars} 字符 (≈{chars // 4} token) | "
          f"系统提示各节 {sect} 字符 | 合计 ≈{(chars + sect) // 4} token")
    print(f"   工具: {', '.join(names)}")
