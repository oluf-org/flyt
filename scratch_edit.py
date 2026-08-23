import io

p = 'kernel/src/plugins/blocks-aistep.ts'
s = io.open(p, encoding='utf-8', newline='').read().replace('\r\n', '\n')

old = (
    "/**\n"
    " * Run one bounded pass over the block's input.\n"
    " *\n"
    " * @param run — the block's execution context.\n"
    " * @param brief — the block's standing instructions (its role).\n"
    " * @returns what it produced, and why it stopped.\n"
    " */\n"
    "export async function executeAiStep(run: BlockRun, brief: string): Promise<BlockOutcome> {"
)
new = (
    "/**\n"
    " * The field a one-shot step fills when its block declares no narrower name.\n"
    " *\n"
    " * Every named ai-step block passes its own declared field; the fallback keeps\n"
    " * the executor callable without one.\n"
    " */\n"
    "export const AI_STEP_OUTPUT = 'text';\n"
    "\n"
    "/**\n"
    " * Run one bounded pass over the block's input.\n"
    " *\n"
    " * @param run — the block's execution context.\n"
    " * @param brief — the block's standing instructions (its role).\n"
    " * @param output — the declared structured field this pass fills, and what it\n"
    " *   holds: the deliverable itself unless it is 'list', when the deliverable\n"
    " *   is the newline-separated items a For each roster may be read from (D56).\n"
    " * @returns what it produced, and why it stopped.\n"
    " */\n"
    "export async function executeAiStep(\n"
    "  run: BlockRun, brief: string, output: { name: string; type?: 'string' | 'list' } = { name: AI_STEP_OUTPUT },\n"
    "): Promise<BlockOutcome> {"
)
assert s.count(old) == 1, 'signature anchor not found'
s = s.replace(old, new)

old_ret = "  return { status: 'done', output: result.content };"
new_ret = (
    "  // The declaration is the contract: the one field this block declared is\n"
    "  // the one field `structured` carries, so a predicate or a roster never\n"
    "  // names a field the block did not fill.\n"
    "  const structured = output.type === 'list'\n"
    "    ? { [output.name]: result.content.split('\\n').map(line => line.trim()).filter(Boolean) }\n"
    "    : { [output.name]: result.content };\n"
    "  return { status: 'done', output: result.content, structured };"
)
assert s.count(old_ret) == 1, 'return anchor not found'
s = s.replace(old_ret, new_ret)

io.open(p, 'w', encoding='utf-8', newline='\r\n').write(s)
print('ok')
