chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[CONTENT] received external message", message);

  return true;
});
