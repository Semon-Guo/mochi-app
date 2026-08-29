/* 照片存 IndexedDB（按磁盘算容量），localStorage 只留 id —— 一张手机照片
   转 base64 有 2–4MB，塞进 localStorage 两张就把整个 app 的数据写爆了。 */
const PDB = "mochi_photos";

function photoDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(PDB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("p")) r.result.createObjectStore("p"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// fn 必须返回 IDBRequest，这样 rq.result 的含义才统一：
// 取不到的 key 得到 undefined，而不是把请求对象本身漏出去
function photoTx(mode, fn) {
  return photoDB().then(db => new Promise((res, rej) => {
    const tx = db.transaction("p", mode);
    const rq = fn(tx.objectStore("p"));
    tx.oncomplete = () => res(rq.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}

export const putPhoto = (id, blob) => photoTx("readwrite", st => st.put(blob, id)).then(() => id);
export const getPhoto = (id) => photoTx("readonly", st => st.get(id));
export const delPhoto = (id) => photoTx("readwrite", st => st.delete(id)).then(() => true);
export const localPhotoIds = () => photoTx("readonly", st => st.getAllKeys());
/** 换账号时要连照片一起清——它们属于上一个登录的人 */
export const clearPhotos = () => photoTx("readwrite", st => st.clear()).then(() => true);
