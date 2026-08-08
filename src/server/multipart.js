export function parseBoundary(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) {
    return null;
  }
  return match[1] || match[2];
}

export function parseMultipart(buffer, boundary) {
  const raw = buffer.toString('binary');
  const rawParts = raw.split(`--${boundary}`).slice(1, -1);
  const fields = {};
  const files = [];

  for (let part of rawParts) {
    if (part.startsWith('\r\n')) {
      part = part.slice(2);
    }
    if (part.endsWith('\r\n')) {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      continue;
    }
    const headerBlock = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 4);

    const dispositionMatch =
      /Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headerBlock);
    if (!dispositionMatch) {
      continue;
    }
    const [, name, filename] = dispositionMatch;

    if (filename !== undefined) {
      const contentTypeMatch = /Content-Type:\s*(.+)/i.exec(headerBlock);
      files.push({
        fieldName: name,
        filename,
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
        buffer: Buffer.from(body, 'binary'),
      });
    } else {
      fields[name] = body;
    }
  }

  return { fields, files };
}
