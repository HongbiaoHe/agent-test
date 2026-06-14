"use client";

import { useQuery } from "@tanstack/react-query";
import { signOut } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getMe } from "@/lib/api";

export const ME_QUERY_KEY = ["me"] as const;

/** 账户只读信息：email / 租户 / 注册时间。 */
export function AccountCard() {
  const query = useQuery({ queryKey: ME_QUERY_KEY, queryFn: getMe });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Account</CardTitle>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-20 w-full rounded-lg" />
        ) : query.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {query.error instanceof Error ? query.error.message : "Failed to load"}
          </p>
        ) : query.data ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="truncate font-medium">{query.data.email}</dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">Workspace</dt>
              <dd className="truncate font-medium">{query.data.tenantName}</dd>
            </div>
            <div className="space-y-0.5">
              <dt className="text-muted-foreground">Member since</dt>
              <dd className="font-medium">
                {new Date(query.data.createdAt).toLocaleDateString()}
              </dd>
            </div>
          </dl>
        ) : null}
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button
          variant="destructive"
          onClick={async () => {
            await signOut({ redirect: false });
            window.location.href = "/login";
          }}
        >
          Sign out
        </Button>
      </CardFooter>
    </Card>
  );
}
