import fs from 'node:fs/promises';
import path from 'node:path';

export async function privateDirectory(directory) {
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 await fs.chmod(directory,0o700);
}
export async function atomicJson(file,value) {
 const temporary=file+'.tmp';
 await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});
 await fs.chmod(temporary,0o600);
 const handle=await fs.open(temporary,'r+');
 try {await handle.sync();}finally {await handle.close();}
 await fs.rename(temporary,file);
 // Persist the rename before refresh confirmation invalidates the old token.
 const directory=await fs.open(path.dirname(file),'r');
 try {await directory.sync();}finally {await directory.close();}
}
