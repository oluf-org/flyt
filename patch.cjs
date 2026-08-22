const fs=require('fs');
let s=fs.readFileSync('core/backlog.js','utf8');
if(!s.includes('reserveId')){
  const marker='  // An id is only ever the stem of a file this class wrote.';
  const insert=`  /**
   * Reserve the next task id without writing a file.
   * Used by enqueue_task in propose mode: the chat proposes, the human commits,
   * so the id must not be reused before they press Queue it.
   */
  reserveId() {
    this.#ensure();
    let n = this.#highWater();
    for (let attempt = 0; attempt < 50; attempt++) {
      const id = \`t-\${String(++n).padStart(4, '0')}\`;
      const file = this.#file(id);
      if (!fs.existsSync(file)) {
        this.#recordId(id);
        return id;
      }
    }
    throw new Error('Could not allocate a task id.');
  }

  // An id is only ever the stem of a file this class wrote.`;
  s=s.replace(marker, insert);
  fs.writeFileSync('core/backlog.js', s);
  console.log('patched backlog');
} else console.log('already');
