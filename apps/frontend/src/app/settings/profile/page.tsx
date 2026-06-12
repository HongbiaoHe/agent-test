"use client";

import { AccountCard } from "./_components/account-card";
import { PasskeysCard } from "./_components/passkeys-card";

// /settings/profile：账户只读信息 + passkey 管理。
export default function ProfileSettingsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">Profile</h2>
        <p className="text-sm text-muted-foreground">
          Your account information and sign-in methods.
        </p>
      </header>
      <AccountCard />
      <PasskeysCard />
    </div>
  );
}
