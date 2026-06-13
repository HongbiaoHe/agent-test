"use client";

import { startRegistration } from "@simplewebauthn/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  KeyRound,
  Loader2,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  deleteMyPasskey,
  getMe,
  myPasskeyOptions,
  myPasskeyVerify,
  type MyPasskey,
} from "@/lib/api";

import { ME_QUERY_KEY } from "./account-card";

/** Passkey 管理：列表 / 添加（先内联确认绑定邮箱，再走 WebAuthn 注册）/ 删除（两步确认）。 */
export function PasskeysCard() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ME_QUERY_KEY, queryFn: getMe });
  const [confirmingAdd, setConfirmingAdd] = useState(false);

  const addMut = useMutation({
    mutationFn: async () => {
      const options = await myPasskeyOptions();
      // 用户在系统弹窗取消时 startRegistration 抛 NotAllowedError，
      // 由 mutation 错误态接住，与其他失败一致展示
      const response = await startRegistration({ optionsJSON: options });
      return myPasskeyVerify(response);
    },
    onSuccess: () => {
      setConfirmingAdd(false);
      qc.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });

  const email = query.data?.email;
  const passkeys = query.data?.passkeys ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Passkeys</CardTitle>
          <CardDescription>
            Sign in with Touch ID, Windows Hello, or a security key.
          </CardDescription>
        </div>
        <Button
          size="sm"
          disabled={addMut.isPending || confirmingAdd || !email}
          onClick={() => {
            addMut.reset();
            setConfirmingAdd(true);
          }}
        >
          <Plus className="size-4" />
          Add passkey
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {confirmingAdd && (
          <div className="space-y-3 rounded-lg border border-primary/40 bg-accent/40 px-3 py-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">
                Add a passkey for this account
              </p>
              <p className="text-sm text-muted-foreground">
                This passkey will be bound to{" "}
                <span className="font-medium text-foreground">{email}</span>.
                The account can&apos;t be changed.
              </p>
            </div>
            {addMut.isError && (
              <p className="text-sm text-destructive" role="alert">
                {addMut.error instanceof Error
                  ? addMut.error.message
                  : "Failed to add passkey"}
              </p>
            )}
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                disabled={addMut.isPending}
                onClick={() => addMut.mutate()}
              >
                {addMut.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <KeyRound className="size-4" />
                )}
                Confirm &amp; continue
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={addMut.isPending}
                onClick={() => {
                  addMut.reset();
                  setConfirmingAdd(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {query.isLoading ? (
          <Skeleton className="h-16 w-full rounded-lg" />
        ) : query.isError ? (
          // 错误细节由同页 AccountCard（同 query）展示，这里只给中性占位避免误导性空态
          <p className="py-2 text-sm text-muted-foreground">
            Could not load passkeys.
          </p>
        ) : passkeys.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No passkeys yet — add one to sign in without a password.
          </p>
        ) : (
          passkeys.map((pk) => <PasskeyRow key={pk.id} passkey={pk} />)
        )}
      </CardContent>
    </Card>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

function PasskeyRow({ passkey }: { passkey: MyPasskey }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const deleteMut = useMutation({
    mutationFn: () => deleteMyPasskey(passkey.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ME_QUERY_KEY }),
  });

  const isSynced = passkey.deviceType === "multiDevice";

  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1.5">
          <p className="truncate text-sm font-medium">{passkey.providerName}</p>
          <div className="flex flex-wrap items-center gap-1">
            {passkey.deviceType && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Smartphone className="size-3" />
                {isSynced ? "Synced" : "Single device"}
              </Badge>
            )}
            {passkey.backedUp && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <ShieldCheck className="size-3" />
                Backed up
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>Added {fmtDate(passkey.createdAt)}</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" />
              {passkey.lastUsedAt
                ? `Last used ${fmtDate(passkey.lastUsedAt)}`
                : "Never used"}
            </span>
          </div>
          {deleteMut.isError && (
            <p className="text-xs text-destructive" role="alert">
              {deleteMut.error instanceof Error
                ? deleteMut.error.message
                : "Failed to delete passkey"}
            </p>
          )}
        </div>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="destructive"
            size="sm"
            disabled={deleteMut.isPending}
            onClick={() => deleteMut.mutate()}
          >
            {deleteMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Confirm delete"
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={deleteMut.isPending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete passkey"
          className="shrink-0"
          onClick={() => setConfirming(true)}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}
