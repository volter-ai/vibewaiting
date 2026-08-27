document.body.innerHTML = "<main>Replace this starter with the requested game.</main>";

window.parent?.postMessage({ type: "browser-agent-rendered", revision: "starter" }, "*");

if (import.meta.hot) import.meta.hot.accept();
