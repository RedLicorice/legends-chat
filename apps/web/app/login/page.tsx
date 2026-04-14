export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="mb-3 text-3xl font-semibold tracking-tight">Legends Chat</h1>
        <p className="mb-6 text-muted">
          To log in, open Telegram and message the community bot. Send <code className="text-accent">/start</code> and
          tap the link the bot sends back.
        </p>
        <p className="text-sm text-muted">If you do not have an invite code yet, ask a member to generate one for you.</p>
      </div>
    </main>
  );
}
