/** Match only server-issued paths; a stored external URL must never receive our token. */
export function managedAvatarPath(url: string): string | null {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const match = new RegExp(`^/api/v1/users/(${uuid})/avatar\\?v=(${uuid})$`, 'i').exec(url);
  return match ? `/users/${match[1]}/avatar?v=${match[2]}` : null;
}

/** Browser decoding honors JPEG orientation. The server validates and normalizes again. */
export async function prepareAvatarUpload(file: File, maxBytes: number, size: number): Promise<File> {
  if (file.size > maxBytes) throw new Error(`头像图片不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (!['image/png', 'image/jpeg'].includes(file.type) && !(file.type === '' && /\.(png|jpe?g)$/i.test(file.name))) {
    throw new Error('请选择 PNG 或 JPG 图片');
  }
  const sourceURL = URL.createObjectURL(file);
  try {
    const source = new Image();
    source.src = sourceURL;
    try { await source.decode(); } catch { throw new Error('图片无法读取，请选择有效的 PNG 或 JPG 图片'); }
    if (source.naturalWidth > 4096 || source.naturalHeight > 4096 || !source.naturalWidth || !source.naturalHeight) {
      throw new Error('图片长宽均不能超过 4096 像素');
    }
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片，请更新浏览器后重试');
    const side = Math.min(source.naturalWidth, source.naturalHeight);
    context.drawImage(source, (source.naturalWidth - side) / 2, (source.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => {
      if (result) resolve(result); else reject(new Error('图片处理失败，请重试'));
    }, 'image/png'));
    return new File([blob], 'avatar.png', { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(sourceURL);
  }
}
