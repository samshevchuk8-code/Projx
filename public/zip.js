// Minimal, dependency-free ZIP writer (STORE method — no compression).
// Good enough to bundle a handful of small text files for download. Exposes
// window.makeZip(files) -> Blob, where files is [{ name, content }] (UTF-8 text).
(function () {
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  // DOS time/date for the ZIP entries (just use "now"; not important).
  function dosDateTime(d) {
    const time =
      (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    const date =
      (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time & 0xffff, date: date & 0xffff };
  }

  function writeUint32(arr, v) {
    arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  function writeUint16(arr, v) {
    arr.push(v & 0xff, (v >>> 8) & 0xff);
  }

  window.makeZip = function makeZip(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const { time, date } = dosDateTime(now);

    const localParts = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = encoder.encode(file.content);
      const crc = crc32(dataBytes);
      const size = dataBytes.length;

      // Local file header
      const local = [];
      writeUint32(local, 0x04034b50);
      writeUint16(local, 20); // version needed
      writeUint16(local, 0); // flags
      writeUint16(local, 0); // method: store
      writeUint16(local, time);
      writeUint16(local, date);
      writeUint32(local, crc);
      writeUint32(local, size); // compressed size
      writeUint32(local, size); // uncompressed size
      writeUint16(local, nameBytes.length);
      writeUint16(local, 0); // extra length
      const localHeader = new Uint8Array(local);

      const localEntry = new Uint8Array(localHeader.length + nameBytes.length + dataBytes.length);
      localEntry.set(localHeader, 0);
      localEntry.set(nameBytes, localHeader.length);
      localEntry.set(dataBytes, localHeader.length + nameBytes.length);
      localParts.push(localEntry);

      // Central directory header
      const cd = [];
      writeUint32(cd, 0x02014b50);
      writeUint16(cd, 20); // version made by
      writeUint16(cd, 20); // version needed
      writeUint16(cd, 0); // flags
      writeUint16(cd, 0); // method
      writeUint16(cd, time);
      writeUint16(cd, date);
      writeUint32(cd, crc);
      writeUint32(cd, size);
      writeUint32(cd, size);
      writeUint16(cd, nameBytes.length);
      writeUint16(cd, 0); // extra
      writeUint16(cd, 0); // comment
      writeUint16(cd, 0); // disk number
      writeUint16(cd, 0); // internal attrs
      writeUint32(cd, 0); // external attrs
      writeUint32(cd, offset); // local header offset
      const cdHeader = new Uint8Array(cd);
      const cdEntry = new Uint8Array(cdHeader.length + nameBytes.length);
      cdEntry.set(cdHeader, 0);
      cdEntry.set(nameBytes, cdHeader.length);
      central.push(cdEntry);

      offset += localEntry.length;
    }

    const centralSize = central.reduce((n, e) => n + e.length, 0);
    const centralOffset = offset;

    const end = [];
    writeUint32(end, 0x06054b50);
    writeUint16(end, 0); // disk
    writeUint16(end, 0); // disk with CD
    writeUint16(end, files.length); // entries on this disk
    writeUint16(end, files.length); // total entries
    writeUint32(end, centralSize);
    writeUint32(end, centralOffset);
    writeUint16(end, 0); // comment length

    const blobParts = [...localParts, ...central, new Uint8Array(end)];
    return new Blob(blobParts, { type: 'application/zip' });
  };
})();
