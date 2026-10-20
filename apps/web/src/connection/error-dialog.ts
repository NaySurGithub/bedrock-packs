export function mountConnectionError(parent: HTMLElement) {
    const dialog = document.createElement('dialog');
    dialog.className = 'connection-error-dialog';
    dialog.setAttribute('aria-labelledby', 'connection-error-title');
    dialog.setAttribute('aria-describedby', 'connection-error-message');
    const title = document.createElement('h2');
    title.id = 'connection-error-title';
    title.textContent = 'Connection interrupted';
    const message = document.createElement('p');
    message.id = 'connection-error-message';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'OK';
    close.autofocus = true;
    close.addEventListener('click', () => dialog.close());
    dialog.append(title, message, close);
    parent.append(dialog);
    return {
        show(reason: string) {
            // Disconnect text is untrusted server content, never markup.
            message.textContent = reason || 'The connection closed unexpectedly.';
            if (!dialog.open) dialog.showModal();
        },
        dismiss() {
            if (dialog.open) dialog.close();
        },
        dispose() {
            dialog.close();
            dialog.remove();
        },
    };
}
