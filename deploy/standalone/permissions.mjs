import assert from 'node:assert/strict';
import {mkdir,readdir,lstat,chown} from 'node:fs/promises';
import path from 'node:path';
assert(process.getuid?.()===0,'Run this one-time command as the container root user');
const directory='/migration';await mkdir(directory,{recursive:true,mode:0o700});
assert(!(await lstat(directory)).isSymbolicLink(),'MIGRATION_DIRECTORY_MUST_NOT_BE_SYMLINK');
await chown(directory,1000,1000);
for(const name of await readdir(directory))if(/\.(pnbak|pnkey)$/.test(name)){
 const file=path.join(directory,name);assert((await lstat(file)).isFile()&&!(await lstat(file)).isSymbolicLink(),'REGULAR_MIGRATION_FILE_REQUIRED');await chown(file,1000,1000);
}
console.log('Migration archive permissions assigned to the application container user.');
