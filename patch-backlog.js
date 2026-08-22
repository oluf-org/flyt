const fs=require('fs');
let s=fs.readFileSync('core/backlog.js','utf8');
const marker = "  // An id is only ever the stem of a file this class wrote.";
if(s.includes("reserveId")) { console.log("already has reserveId"); process.exit(0); }
const insert = "  /**\n   * Reserve the next task id without writing a file.\n   * Used by enqueue_task in propose mode: the chat proposes, the human commits,\n   * so the id must not be reused before they press Queue it.\n   */\n  reserveId() {\n    this.#ensure();\n    let n = this.#highWater();\n    for (let attempt = 0; attempt < 50; attempt++) {\n      const id = `t-${String(++n).padStart(4, '0')}`;\n      const file = this.#file(id);\n      if (!fs.existsSync(file)) {\n        this.#recordId(id);\n        return id;\n      }\n    }\n    throw new Error('Could not allocate a task id.');\n  }\n\n  // An id is only ever the stem of a file this class wrote.";
if(!s.includes(marker)) { console.error("marker not found"); process.exit(1); }
s=s.replace(marker, insert);
fs.writeFileSync('core/backlog.js', s);
console.log("backlog.js patched");
