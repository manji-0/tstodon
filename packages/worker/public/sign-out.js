// @ts-check
// The sign-in page's "Sign out" button (server/auth-pages.ts): a script file,
// as the content security policy runs no inline script.
(function () {
  'use strict';

  const form = document.getElementById('sign-out');
  const error = document.getElementById('error');
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  /** @param {unknown} body */
  const redirectTo = (body) =>
    typeof body === 'object' && body !== null && 'redirect_to' in body && typeof body.redirect_to === 'string'
      ? body.redirect_to
      : form.dataset.logoutPath ?? '/';

  const signOut = async () => {
    const response = await fetch('/auth/sign_out', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      if (error) {
        error.textContent = response.statusText;
      }
      return;
    }
    /** @type {unknown} */
    const body = await response.json();
    location.assign(redirectTo(body));
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void signOut();
  });
})();
