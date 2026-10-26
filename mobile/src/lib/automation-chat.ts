export type AutomationChatSendOptions = {
  draft: string;
  owner?: string;
  projectId: string | null;
  isCurrent: () => boolean;
  post: (body: {
    message: string;
    project_id: string | null;
  }) => Promise<unknown>;
  open: () => void;
  busy: (sending: boolean) => void;
  error: (message: string) => void;
  accepted: () => void;
  refresh: () => Promise<void>;
};

export type AutomationChatController = {
  cancel: () => void;
  send: (options: AutomationChatSendOptions) => Promise<boolean>;
};

/** One conversation request at a time, scoped to its current account and view. */
export function createAutomationChatController(): AutomationChatController {
  let active: object | null = null;
  return {
    cancel() {
      // Invalidates old callbacks without allowing their finally block to unlock
      // a newer request. The owner of the UI resets its own draft/busy state.
      active = null;
    },
    async send(options) {
      if (active || !options.isCurrent()) return false;
      if (!options.owner?.trim()) {
        options.error("Sign in to ask Ziipa to automate your workspace.");
        return false;
      }
      const message = options.draft.trim();
      if (!message || message.length > 3000) {
        options.error(
          !message
            ? "Enter a request for Ziipa."
            : "Keep your request to 3,000 characters or fewer.",
        );
        return false;
      }

      const job = {};
      active = job;
      const current = () => active === job && options.isCurrent();
      let acknowledged = false;
      try {
        options.busy(true);
        options.error("");
        options.open();
        if (!current()) return false;
        await options.post({ message, project_id: options.projectId });
        if (!current()) return false;
        acknowledged = true;
        options.accepted();
        if (!current()) return false;
        await options.refresh();
        return current();
      } catch (error) {
        if (!current()) return false;
        options.error(
          acknowledged
            ? "Your message was sent, but the conversation could not refresh. Refresh the workspace to see the reply."
            : error instanceof Error && error.message.trim()
              ? error.message
              : "Ziipa could not send this request. Please try again.",
        );
        // A refresh failure must not encourage resending an acknowledged message.
        return acknowledged;
      } finally {
        if (active === job) {
          const visible = options.isCurrent();
          active = null;
          if (visible) options.busy(false);
        }
      }
    },
  };
}
