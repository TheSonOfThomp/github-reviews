declare namespace chrome.runtime {
  export interface Message {
    action: string;
    payload?: any;
  }

  export interface Response {
    action: string;
    payload?: any;
    message?: Message;
  }

  export type onMessageCallback = (
    message: Message,
    sender: MessageSender,
    sendResponse: (response: Response) => void
  ) => void;

  const onMessage: chrome.events.Event<onMessageCallback>;
  const onMessageExternal: chrome.events.Event<onMessageCallback>;
}
