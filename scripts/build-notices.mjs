/** Keep licenses and the exact unmodified noVNC source beside the served bundle. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const output = path.resolve('dist/web/third-party');
await mkdir(output, { recursive: true });
await cp('LICENSE', path.join(output, 'BLENDER-PILOT-LICENSE.txt'));
await cp('THIRD_PARTY_NOTICES.md', path.join(output, 'NOTICES.md'));
const root = path.resolve('node_modules/@novnc/novnc');
const novnc = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await cp(root, path.join(output, 'novnc'), { recursive: true });
await writeFile(path.join(output, 'README.txt'), `Blender Pilot: MIT (original code only).\nSee BLENDER-PILOT-LICENSE.txt and NOTICES.md.\nnoVNC ${novnc.version}: MPL-2.0 and bundled notices.\nExact installed, unmodified noVNC source and license files: ./novnc/\nThese files accompany the browser build; dependency licenses are not replaced by the project MIT license.\n`);
