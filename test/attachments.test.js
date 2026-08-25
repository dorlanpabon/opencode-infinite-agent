const assert = require('node:assert/strict');
const { mkdtemp, rm, symlink, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertAttachmentMetadata,
  attachmentMime,
  inspectAttachments,
  parseDroppedPaths,
} = require('../dist/desktop/attachments.js');

test('adjuntos reconocen los tipos soportados y rechazan binarios desconocidos', () => {
  assert.equal(attachmentMime('screen.PNG'), 'image/png');
  assert.equal(attachmentMime('photo.jpeg'), 'image/jpeg');
  assert.equal(attachmentMime('animation.gif'), 'image/gif');
  assert.equal(attachmentMime('capture.webp'), 'image/webp');
  assert.equal(attachmentMime('brief.pdf'), 'application/pdf');
  assert.equal(attachmentMime('notes.md'), 'text/plain');
  assert.throws(() => attachmentMime('archive.zip'), /no compatible/iu);
});

test('selector normaliza rutas, deduplica archivos y detecta metadatos cambiados', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-attachments-'));
  const file = path.join(root, 'objective.md');
  const link = path.join(root, 'objective-link.md');
  await writeFile(file, 'objetivo');
  t.after(() => rm(root, { recursive: true, force: true }));
  let candidates = [file, file];
  try {
    await symlink(file, link, 'file');
    candidates.push(link);
  } catch (error) {
    if (!error || (error.code !== 'EPERM' && error.code !== 'EACCES')) throw error;
  }
  const selected = await inspectAttachments(candidates);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].mime, 'text/plain');
  await assertAttachmentMetadata(selected);
  await writeFile(file, 'objetivo actualizado');
  await assert.rejects(assertAttachmentMetadata(selected), /cambiaron/iu);
});

test('drop seguro rechaza payloads y rutas que no son archivos absolutos', async () => {
  assert.throws(() => parseDroppedPaths('relative.md'), /no son válidas/iu);
  assert.throws(() => parseDroppedPaths([1]), /no son válidas/iu);
  await assert.rejects(inspectAttachments(Array.from({ length: 101 }, (_, index) => path.resolve(`${index}.md`))), /hasta 100/iu);
  await assert.rejects(inspectAttachments(['relative.md']), /ruta absoluta/iu);
});
