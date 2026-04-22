function getSelectedText() {
  const selected = window.getSelection();
  if (!selected) return "";
  return selected.toString().trim();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "ELIZA_GET_SELECTION") {
    return;
  }

  sendResponse({
    selectedText: getSelectedText(),
  });
});
