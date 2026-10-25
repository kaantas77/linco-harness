/** Pi catalog input list. DeepSeek Flash includes image. DeepSeek Pro and the scripted model do not. */
export function modelAcceptsImages(model: { input?: readonly string[] } | undefined): boolean {
  return Boolean(model?.input?.includes("image"));
}
