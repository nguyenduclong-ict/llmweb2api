import { toast } from 'sonner';

export function toastSuccess(message: string) {
  toast.success(message);
}

export function toastError(message: string) {
  toast.error(message);
}

export function toastLoading(message: string) {
  return toast.loading(message);
}

export function toastDismiss(id: string | number) {
  toast.dismiss(id);
}

export async function withToast<T>(
  fn: () => Promise<T>,
  messages: { loading: string; success: string; error: string },
): Promise<T | undefined> {
  const id = toastLoading(messages.loading);
  try {
    const result = await fn();
    toastDismiss(id);
    toastSuccess(messages.success);
    return result;
  } catch (err) {
    toastDismiss(id);
    const msg = err instanceof Error ? err.message : messages.error;
    toastError(msg);
    return undefined;
  }
}
