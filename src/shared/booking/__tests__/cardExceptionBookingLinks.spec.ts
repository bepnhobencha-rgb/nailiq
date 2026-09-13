import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/shared/lib/useUserLanguage", () => ({ useUserLanguage: () => ({ language: "en" }) }));
vi.mock("../cardProtectionExceptionActions", () => ({ actOnCardProtectionException: vi.fn() }));
vi.mock("../ownerCardRemovalActions", () => ({ reconcileOwnerCardRemoval: vi.fn() }));
import { CardProtectionExceptions } from "@/components/dashboard/CardProtectionExceptions";
import { OwnerCardRemovalExceptions } from "@/components/dashboard/OwnerCardRemovalExceptions";

const bookingId="00000000-0000-4000-8000-000000000001";
describe.each([
  ["America/Vancouver","2026-09-27T01:00:00Z","2026-09-26"],
  ["Europe/Paris","2026-09-26T23:30:00Z","2026-09-27"],
  ["America/Vancouver","2026-11-01T09:30:00Z","2026-11-01"],
])("exception booking links use salon date (%s, %s)",(timezone,startTime,expectedDate)=>{
  it.each(["save","removal"])("%s opens the selected appointment on its calendar day",kind=>{
    const common={bookingId,clientLabel:"S. Q.",startTime,service:"QA",lastAttemptAt:startTime};
    const html=kind==="save"?renderToStaticMarkup(createElement(CardProtectionExceptions,{slug:"qa-salon",timezone,result:{ok:true,items:[{...common,status:"awaiting_card",failureStage:null,failureCode:null,reviewedAt:null,hasExistingCard:false,canReconcile:false}]}})):
      renderToStaticMarkup(createElement(OwnerCardRemovalExceptions,{slug:"qa-salon",timezone,result:{ok:true,items:[{...common,operationId:"00000000-0000-4000-8000-000000000002",reason:null,canReconcile:false}]}}));
    const href=html.match(/href="([^"]+\/center\?[^"]+)"/)?.[1]?.replaceAll("&amp;","&");
    expect(href).toBeTruthy();const link=new URL(href!,"https://qa.invalid");
    expect(link.pathname).toBe("/dashboard/qa-salon/center");
    expect(link.searchParams.get("date")).toBe(expectedDate);
    expect(link.searchParams.get("booking")).toBe(bookingId);
  });
});
