# Security gates

Public use: NO-GO.

- The redirect left the page on the public redirect URL. The metadata address was not observed, and Chrome did not return an explicit refusal. That is not a verified block.
- The shell and Chrome share uid 1000. The same user can still open the control socket or start its own Chrome. Loopback TCP 9333 is closed; that does not make the browser a separate trust domain. Public use is NO-GO.
- The egress proxy pins the first DNS answer for proxied requests. It does not prove every subresource and does not re-check DNS after a TTL change.

Production approval is a user decision. The live matrix approves Boat tools inside the test process so a task can finish. That does not replace the user.

Password, CAPTCHA, MFA, payment, purchase, send, and delete stay on the existing user-control path.
