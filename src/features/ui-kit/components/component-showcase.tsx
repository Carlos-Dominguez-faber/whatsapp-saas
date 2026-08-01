"use client";

/**
 * Component Showcase — Visual source of truth for the project.
 * Every agent building UI MUST reference this page. See COMPONENT_RULES.md.
 * No new component variants without updating this file first.
 */

import * as React from "react";
import { useTheme } from "next-themes";
import {
  Sun,
  Moon,
  Search,
  Plus,
  MoreHorizontal,
  Check,
  AlertTriangle,
  Info,
  CheckCircle2,
  XCircle,
  Bell,
  Settings,
  Inbox,
  MessageSquare,
  Users,
  LayoutDashboard,
  Bot,
  Phone,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  FileText,
  Loader2,
  Mail,
  Eye,
  EyeOff,
  ChevronRight,
  SearchX,
  Menu,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

import { ViewportToggle } from "./viewport-toggle";
import {
  FeedbackButton,
  GlobalFeedbackButton,
  HowToPanel,
} from "./feedback-panel";

// ============================================================
// BRAND TOKENS — Generated from Design Discovery.
// Primary source: globals.css CSS variables.
// ============================================================
const BRAND = {
  name: "Agente WhatsApp",
  primaryHex: "#B5F23D", // oklch(0.90 0.21 126) — Electric Lime
  accentHex: "#B5F23D",
  font: "Space Grotesk (display) · Geist Sans (body) · Geist Mono",
  personality: "Glass + Electric — Apple/visionOS glassmorphism",
  audience: "B2B · operadores / setters / admins",
  radius: "14px",
};

const HAS_AGENTATION = process.env.NEXT_PUBLIC_HAS_AGENTATION === "true";

// ============================================================
// Helpers
// ============================================================
function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  React.useEffect(() => setMounted(true), []);
  const isDark = resolvedTheme === "dark";
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Cambiar tema"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {mounted && isDark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
}

function TokenRow({ tokens }: { tokens: string[] }) {
  if (!tokens.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tokens.map((t) => (
        <code
          key={t}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
        >
          {t}
        </code>
      ))}
    </div>
  );
}

function Section({
  title,
  description,
  tokens = [],
  when,
  whenNot,
  motion,
  children,
}: {
  title: string;
  description: string;
  tokens?: string[];
  when?: string;
  whenNot?: string;
  motion?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="group scroll-mt-20 border-t border-border py-10">
      <div className="mb-5">
        <div className="flex items-center gap-2">
          <h3 className="font-display text-xl font-semibold tracking-tight">
            {title}
          </h3>
          <FeedbackButton section={title} hasAgentation={HAS_AGENTATION} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          {when && (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Cuándo:</span>{" "}
              {when}
            </p>
          )}
          {whenNot && (
            <p className="text-muted-foreground">
              <span className="font-medium text-destructive">Cuándo NO:</span>{" "}
              {whenNot}
            </p>
          )}
          {motion && (
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Motion:</span>{" "}
              {motion}
            </p>
          )}
        </div>
        <div className="mt-3">
          <TokenRow tokens={tokens} />
        </div>
      </div>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

// ============================================================
// PART 1 — Design Tokens & Components
// ============================================================

function ColorPalette() {
  const colors = [
    ["--background", "bg-background"],
    ["--card", "bg-card"],
    ["--primary", "bg-primary"],
    ["--secondary", "bg-secondary"],
    ["--accent", "bg-accent"],
    ["--muted", "bg-muted"],
    ["--destructive", "bg-destructive"],
    ["--success", "bg-success"],
    ["--warning", "bg-warning"],
    ["--info", "bg-info"],
    ["--border", "bg-border"],
    ["--foreground", "bg-foreground"],
  ];
  return (
    <Section
      title="Color Palette"
      description="Todos los colores vienen de CSS variables OKLch. Nunca hardcodear hex en componentes."
      tokens={[
        "--primary",
        "--background",
        "--card",
        "--muted",
        "--destructive",
      ]}
      when="Siempre, vía clases semánticas (bg-primary, text-muted-foreground)."
      whenNot="Nunca hardcodees hex ni colores literales de Tailwind para marca."
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {colors.map(([token, cls]) => (
          <div
            key={token}
            className="overflow-hidden rounded-md border border-border"
          >
            <div className={cn("h-16 w-full", cls)} />
            <div className="bg-card p-2">
              <code className="font-mono text-[11px] text-muted-foreground">
                {token}
              </code>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Todos los tokens cambian automáticamente con{" "}
        <code className="font-mono">.dark</code>.
      </p>
    </Section>
  );
}

function Typography() {
  return (
    <Section
      title="Typography"
      description="Space Grotesk para display, Geist Sans para body, Geist Mono para datos."
      tokens={["--font-display", "--font-geist-sans", "--font-geist-mono"]}
      when="Máximo 3 tamaños de texto por pantalla. tracking-tight en headings grandes."
      whenNot="No usar text-xs para texto de lectura sostenida."
    >
      <div className="space-y-3">
        <p className="font-display text-5xl font-bold tracking-tight">
          Display / Hero
        </p>
        <p className="font-display text-3xl font-semibold tracking-tight">
          H1 · Inbox
        </p>
        <p className="font-display text-2xl font-semibold">
          H2 · Conversaciones
        </p>
        <p className="text-xl font-medium">H3 · Detalle del contacto</p>
        <p className="text-base">
          Body — texto base de la interfaz (Geist Sans).
        </p>
        <p className="text-sm text-muted-foreground">
          Small / Caption — metadatos.
        </p>
        <p className="font-mono text-sm">
          Mono — +507 6344 0979 · wamid_HBgNCg==
        </p>
      </div>
    </Section>
  );
}

function Buttons() {
  const [loading, setLoading] = React.useState(false);
  return (
    <Section
      title="Buttons"
      description="6 variantes canónicas. Máximo 1 default (CTA primario) por contexto."
      tokens={[
        "--primary",
        "--primary-foreground",
        "--secondary",
        "--destructive",
      ]}
      when="default = acción primaria; ghost/outline = secundarias."
      whenNot="No uses default para acciones secundarias en el mismo contexto — confunde jerarquía."
      motion="background-color + opacity en 150ms ease-out-expo."
    >
      <Row label="Variantes">
        <Button>Guardar cambios</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Cancelar</Button>
        <Button variant="destructive">Eliminar</Button>
        <Button variant="link">Link</Button>
      </Row>
      <Row label="Tamaños">
        <Button size="sm">Small</Button>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Notificaciones">
          <Bell className="h-4 w-4" />
        </Button>
      </Row>
      <Row label="Estados">
        <Button disabled>Disabled</Button>
        <Button
          disabled={loading}
          aria-busy={loading}
          onClick={() => {
            setLoading(true);
            setTimeout(() => setLoading(false), 1600);
          }}
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {loading ? "Enviando…" : "Enviar mensaje"}
        </Button>
        <Button>
          <Plus className="h-4 w-4" />
          Con ícono
        </Button>
      </Row>
    </Section>
  );
}

function FormInputs() {
  return (
    <Section
      title="Form Inputs"
      description="Input, Select, Textarea, Switch, Checkbox con todos sus estados."
      tokens={["--input", "--ring", "--destructive", "--muted"]}
      when="Switch para toggles inmediatos; Checkbox para selección que requiere submit."
      whenNot="No uses Switch para acciones que requieren confirmación explícita."
      motion="box-shadow (ring) + border-color en 150ms."
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="demo-email">Email</Label>
          <Input id="demo-email" placeholder="cliente@empresa.com" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="demo-search">Con ícono</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="demo-search"
              placeholder="Buscar conversación…"
              className="pl-9"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="demo-error" className="text-destructive">
            Con error
          </Label>
          <Input
            id="demo-error"
            defaultValue="507"
            aria-invalid
            className="border-destructive focus-visible:ring-destructive"
          />
          <p className="text-xs text-destructive">
            El teléfono debe estar en formato E.164.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="demo-disabled">Disabled</Label>
          <Input id="demo-disabled" placeholder="No editable" disabled />
        </div>
        <div className="space-y-2">
          <Label>Select</Label>
          <Select>
            <SelectTrigger>
              <SelectValue placeholder="Estado de la conversación" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ai">IA activa</SelectItem>
              <SelectItem value="human">Humano activo</SelectItem>
              <SelectItem value="handoff">Handoff pendiente</SelectItem>
              <SelectItem value="closed">Cerrada</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="demo-note">Nota interna</Label>
          <Textarea
            id="demo-note"
            rows={3}
            placeholder="Visible solo para el equipo…"
            className="resize-none"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-8">
        <div className="flex items-center gap-2">
          <Switch id="demo-ai" defaultChecked />
          <Label htmlFor="demo-ai">IA activa</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="demo-check" defaultChecked />
          <Label htmlFor="demo-check">Marcar como prioridad</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="demo-check2" disabled />
          <Label htmlFor="demo-check2" className="text-muted-foreground">
            Disabled
          </Label>
        </div>
      </div>
    </Section>
  );
}

function Cards() {
  return (
    <Section
      title="Cards"
      description="3 variantes: Default (borde), Elevated (sombra), Accent (marca) y Glass (firma)."
      tokens={["--card", "--card-foreground", "--border", "--primary"]}
      when="Default para listas; Elevated para destacar; Accent para KPIs; Glass para superficies hero/sticky."
      whenNot="No anidar Elevated dentro de otra Card. No anidar glass dentro de glass."
      motion="box-shadow en 200ms al hover en cards clickeables."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Default</CardTitle>
            <CardDescription>Con borde, sin sombra.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Listas, contenido estático.
          </CardContent>
        </Card>
        <Card className="border-transparent shadow-md">
          <CardHeader>
            <CardTitle className="text-base">Elevated</CardTitle>
            <CardDescription>Sombra, sin borde.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Elementos destacados.
          </CardContent>
        </Card>
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="text-base text-primary">Accent</CardTitle>
            <CardDescription>Info de marca.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            KPIs, datos clave.
          </CardContent>
        </Card>
        <div className="glass rounded-lg p-6">
          <p className="font-display text-base font-semibold">Glass</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Translúcida + backdrop-blur. La firma visionOS.
          </p>
        </div>
      </div>
    </Section>
  );
}

function Badges() {
  return (
    <Section
      title="Badges & Status"
      description="Informativos, nunca clickeables como botón. Variantes + semánticos + status dot."
      tokens={["--primary", "--secondary", "--destructive", "--muted"]}
      when="Estados, etiquetas, contadores."
      whenNot="No uses Badges para acciones — son informativos."
      motion="Aparición con animate-in fade-in 75ms."
    >
      <Row label="Variantes">
        <Badge>Default</Badge>
        <Badge variant="secondary">Secondary</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Destructive</Badge>
      </Row>
      <Row label="Semánticos">
        <Badge className="border-transparent bg-success/15 text-success">
          Aprobado
        </Badge>
        <Badge className="border-transparent bg-warning/15 text-warning">
          Pendiente Meta
        </Badge>
        <Badge className="border-transparent bg-info/15 text-info">
          Sync HighLevel
        </Badge>
        <Badge variant="secondary">Neutral</Badge>
      </Row>
      <Row label="Status con dot">
        <span className="inline-flex items-center gap-1.5 text-sm">
          <span className="h-2 w-2 rounded-full bg-success" /> Online
        </span>
        <span className="inline-flex items-center gap-1.5 text-sm">
          <span className="h-2 w-2 rounded-full bg-muted-foreground" /> Offline
        </span>
        <span className="inline-flex items-center gap-1.5 text-sm">
          <span className="h-2 w-2 rounded-full bg-warning" /> Handoff pendiente
        </span>
      </Row>
    </Section>
  );
}

function Alerts() {
  return (
    <Section
      title="Alerts"
      description="Info, success, warning, error. Siempre con título + descripción + ícono."
      tokens={["--border", "--background", "--destructive"]}
      when="Mensajes a nivel de sección o página."
      whenNot="No uses Alert para error de un campo — usa texto inline bajo el input."
      motion="animate-in fade-in slide-in-from-top-1 200ms."
    >
      <div className="space-y-3">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>Ventana de 24h activa</AlertTitle>
          <AlertDescription>
            Puedes enviar mensajes de texto libre a este contacto.
          </AlertDescription>
        </Alert>
        <Alert className="border-success/30 text-success [&>svg]:text-success">
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Contacto sincronizado</AlertTitle>
          <AlertDescription>
            El contacto se guardó en HighLevel.
          </AlertDescription>
        </Alert>
        <Alert className="border-warning/30 text-warning [&>svg]:text-warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Ventana cerrada</AlertTitle>
          <AlertDescription>
            Fuera de 24h: solo puedes enviar templates aprobados.
          </AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Error de envío</AlertTitle>
          <AlertDescription>
            Kapso rechazó el mensaje. Revisa el template.
          </AlertDescription>
        </Alert>
      </div>
    </Section>
  );
}

const NAV = [
  { icon: Inbox, label: "Inbox", active: true, badge: 12 },
  { icon: Users, label: "Contactos", active: false },
  { icon: Bot, label: "Agente IA", active: false },
  { icon: FileText, label: "Templates", active: false },
  { icon: Settings, label: "Ajustes", active: false },
];

function Navigation() {
  return (
    <Section
      title="Navigation & Iconografía"
      description="Sidebar nav con estados. Solo íconos Lucide Outline."
      tokens={["--muted-foreground", "--foreground", "--accent"]}
      when="h-4 inline, h-5 sidebar, h-6 standalone."
      whenNot="Nunca mezclar Lucide con otras librerías de íconos."
      motion="nav item hover: background-color 150ms."
    >
      <div className="max-w-xs space-y-1 rounded-lg border border-border bg-card p-2">
        {NAV.map(({ icon: Icon, label, active, badge }) => (
          <div
            key={label}
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-150",
              active
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-5 w-5" />
            <span className="flex-1">{label}</span>
            {badge && (
              <Badge className="border-transparent bg-primary/15 text-primary">
                {badge}
              </Badge>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function LoadingStates() {
  return (
    <Section
      title="Loading States"
      description="Skeleton que imita el layout real, nunca un spinner genérico de página."
      tokens={["--muted"]}
      when="Skeleton para data; spinner inline solo en botones."
      whenNot="No uses spinner de pantalla completa para cargar datos."
      motion="animate-pulse (skeleton), animate-spin (spinner)."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="space-y-3 pt-6">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-16" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-3 pt-6">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-3 pt-6">
            <Progress value={64} />
            <Progress value={100} className="[&>div]:animate-pulse" />
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Procesando…
            </div>
          </CardContent>
        </Card>
      </div>
    </Section>
  );
}

function TabsSection() {
  return (
    <Section
      title="Tabs"
      description="Máximo 5 tabs antes de considerar dropdown o sidebar nav."
      tokens={["--muted", "--background", "--primary"]}
      when="Vistas paralelas del mismo objeto."
      whenNot="No uses Tabs para flujos con progreso — usa pasos numerados."
      motion="background del tab activo: transform 150ms."
    >
      <Tabs defaultValue="todas" className="max-w-md">
        <TabsList>
          <TabsTrigger value="todas">Todas</TabsTrigger>
          <TabsTrigger value="ia">IA</TabsTrigger>
          <TabsTrigger value="humano">Humano</TabsTrigger>
          <TabsTrigger value="cerradas">Cerradas</TabsTrigger>
        </TabsList>
        <TabsContent
          value="todas"
          className="pt-3 text-sm text-muted-foreground"
        >
          Todas las conversaciones del workspace.
        </TabsContent>
        <TabsContent value="ia" className="pt-3 text-sm text-muted-foreground">
          Conversaciones atendidas por IA.
        </TabsContent>
        <TabsContent
          value="humano"
          className="pt-3 text-sm text-muted-foreground"
        >
          Conversaciones con un agente humano.
        </TabsContent>
        <TabsContent
          value="cerradas"
          className="pt-3 text-sm text-muted-foreground"
        >
          Conversaciones cerradas.
        </TabsContent>
      </Tabs>
    </Section>
  );
}

function Avatars() {
  return (
    <Section
      title="Avatars"
      description="Siempre con fallback de iniciales — la imagen puede fallar."
      tokens={["--muted", "--border"]}
      when="h-8 sm, h-10 default, h-14 lg. Avatar group con -space-x-2."
      whenNot="No uses avatar como ícono genérico de usuario desconocido — usa un ícono Lucide."
    >
      <Row label="Tamaños">
        <Avatar className="h-8 w-8">
          <AvatarFallback>CD</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarImage src="https://i.pravatar.cc/80?img=12" alt="" />
          <AvatarFallback>MJ</AvatarFallback>
        </Avatar>
        <Avatar className="h-14 w-14">
          <AvatarFallback>AO</AvatarFallback>
        </Avatar>
      </Row>
      <Row label="Group">
        <div className="flex -space-x-2">
          {["MJ", "AO", "CD", "RL"].map((i) => (
            <Avatar key={i} className="h-9 w-9 border-2 border-background">
              <AvatarFallback className="text-xs">{i}</AvatarFallback>
            </Avatar>
          ))}
          <div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-background bg-muted text-xs font-medium text-muted-foreground">
            +5
          </div>
        </div>
      </Row>
    </Section>
  );
}

function ToastFeedback() {
  return (
    <Section
      title="Toast & Feedback"
      description="Sonner instalado. Para acciones asíncronas completadas, no para errores de form."
      tokens={["--card", "--border"]}
      when="Confirmaciones de acciones async (enviado, guardado)."
      whenNot="Para errores de form usa mensajes inline."
      motion="slide-in-from-bottom + fade-in 200ms. Exit: slide-out-to-right 150ms."
    >
      <Row label="Variantes">
        <Button
          variant="outline"
          onClick={() => toast.success("Mensaje enviado")}
        >
          Success
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.error("Falló el envío a Kapso")}
        >
          Error
        </Button>
        <Button
          variant="outline"
          onClick={() => toast.warning("Ventana de 24h por cerrar")}
        >
          Warning
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            toast("Contacto actualizado", {
              action: { label: "Deshacer", onClick: () => {} },
            })
          }
        >
          Con acción
        </Button>
      </Row>
    </Section>
  );
}

function EmptyStateBlock({
  icon: Icon,
  title,
  description,
  cta,
}: {
  icon: typeof Inbox;
  title: string;
  description: string;
  cta: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        {description}
      </p>
      <Button className="mt-4" size="sm">
        <Plus className="h-4 w-4" />
        {cta}
      </Button>
    </div>
  );
}

function EmptyStates() {
  return (
    <Section
      title="Empty States"
      description="Cada componente con datos tiene su empty state. Ilustración distinta por tipo."
      tokens={["--muted-foreground", "--muted", "--primary"]}
      when="Lista vacía, sin resultados, error, primer uso."
      whenNot="No mostrar empty state con spinner — son estados mutuamente excluyentes."
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <EmptyStateBlock
          icon={Inbox}
          title="Sin conversaciones"
          description="Cuando llegue el primer mensaje de WhatsApp aparecerá aquí."
          cta="Conectar Kapso"
        />
        <EmptyStateBlock
          icon={SearchX}
          title="Sin resultados"
          description="No encontramos conversaciones para tu búsqueda."
          cta="Limpiar filtros"
        />
        <EmptyStateBlock
          icon={Users}
          title="Sin contactos"
          description="Importa o sincroniza contactos desde HighLevel."
          cta="Sincronizar"
        />
      </div>
    </Section>
  );
}

// ============================================================
// PART 2 — SaaS Patterns
// ============================================================

const KPIS = [
  {
    label: "Conversaciones hoy",
    value: "1,284",
    delta: "+12%",
    up: true,
    icon: MessageSquare,
    tint: "text-primary",
  },
  {
    label: "Atendidas por IA",
    value: "73%",
    delta: "+5pp",
    up: true,
    icon: Bot,
    tint: "text-info",
  },
  {
    label: "Handoffs",
    value: "48",
    delta: "-8%",
    up: false,
    icon: Users,
    tint: "text-warning",
  },
  {
    label: "Costo LLM / día",
    value: "$14.20",
    delta: "+3%",
    up: true,
    icon: TrendingUp,
    tint: "text-success",
  },
];

function PatternKPI() {
  const [loading, setLoading] = React.useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="font-display font-semibold">
          Pattern A — Dashboard KPI Row
        </h4>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setLoading(true);
            setTimeout(() => setLoading(false), 1500);
          }}
        >
          Simular loading
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading
          ? KPIS.map((_, i) => (
              <Card key={i}>
                <CardContent className="space-y-3 pt-6">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-3 w-12" />
                </CardContent>
              </Card>
            ))
          : KPIS.map(({ label, value, delta, up, icon: Icon, tint }) => (
              <Card key={label}>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-muted-foreground">{label}</p>
                    <Icon className={cn("h-4 w-4", tint)} />
                  </div>
                  <p className="mt-2 font-display text-3xl font-bold tracking-tight">
                    {value}
                  </p>
                  <p
                    className={cn(
                      "mt-1 inline-flex items-center gap-1 text-xs font-medium",
                      up ? "text-success" : "text-destructive",
                    )}
                  >
                    {up ? (
                      <ArrowUpRight className="h-3 w-3" />
                    ) : (
                      <ArrowDownRight className="h-3 w-3" />
                    )}
                    {delta}
                  </p>
                </CardContent>
              </Card>
            ))}
      </div>
    </div>
  );
}

const ROWS = [
  {
    name: "Maria Jones",
    phone: "+507 6344 0979",
    state: "IA activa",
    tone: "bg-primary/15 text-primary",
  },
  {
    name: "Roberto Lima",
    phone: "+507 6011 2233",
    state: "Handoff",
    tone: "bg-warning/15 text-warning",
  },
  {
    name: "Ana Osandón",
    phone: "+507 6788 4521",
    state: "Humano",
    tone: "bg-info/15 text-info",
  },
];

function PatternTable() {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="font-display font-semibold">
          Pattern B — Data Table con Filtros
        </h4>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Buscar…" className="h-9 w-44 pl-9" />
          </div>
          <Button size="sm">
            <Plus className="h-4 w-4" />
            Nuevo
          </Button>
        </div>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Contacto</TableHead>
              <TableHead>Teléfono</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map((r) => (
              <TableRow key={r.phone}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">
                  {r.phone}
                </TableCell>
                <TableCell>
                  <Badge className={cn("border-transparent", r.tone)}>
                    {r.state}
                  </Badge>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Acciones">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>Abrir conversación</DropdownMenuItem>
                      <DropdownMenuItem>Ver en CRM</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive">
                        Archivar
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <CardFooter className="flex items-center justify-between border-t border-border py-3 text-sm text-muted-foreground">
          <span>1–3 de 47</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled>
              Anterior
            </Button>
            <Button variant="outline" size="sm">
              Siguiente
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}

function PatternOnboarding() {
  return (
    <div className="space-y-3">
      <h4 className="font-display font-semibold">
        Pattern C — Onboarding Step
      </h4>
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <p className="text-xs font-medium text-muted-foreground">
            Paso 2 de 4
          </p>
          <Progress value={50} className="my-2" />
          <CardTitle>Información del negocio</CardTitle>
          <CardDescription>
            Esto alimenta el contexto del agente IA.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ob-name">Nombre del negocio</Label>
            <Input id="ob-name" placeholder="Movinsa" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ob-desc">¿Qué vende?</Label>
            <Textarea
              id="ob-desc"
              rows={3}
              className="resize-none"
              placeholder="Créditos automotrices…"
            />
          </div>
        </CardContent>
        <CardFooter className="justify-between">
          <Button variant="ghost">Atrás</Button>
          <Button>
            Continuar
            <ChevronRight className="h-4 w-4" />
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function PatternSidebar() {
  return (
    <div className="space-y-3">
      <h4 className="font-display font-semibold">
        Pattern D — Sidebar Navigation
      </h4>
      <div className="flex h-72 overflow-hidden rounded-lg border border-border">
        <aside className="flex w-56 flex-col border-r border-border bg-card p-3">
          <div className="mb-4 flex items-center gap-2 px-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <MessageSquare className="h-4 w-4" />
            </div>
            <span className="font-display text-sm font-semibold">
              Agente WhatsApp
            </span>
          </div>
          <nav className="flex-1 space-y-1">
            {NAV.map(({ icon: Icon, label, active }) => (
              <div
                key={label}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-150",
                  active
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                <Icon className="h-5 w-5" />
                {label}
              </div>
            ))}
          </nav>
          <Separator className="my-2" />
          <div className="flex items-center gap-2 px-2 py-1">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="text-xs">CD</AvatarFallback>
            </Avatar>
            <div className="flex-1 text-xs">
              <p className="font-medium">Carlos D.</p>
              <p className="text-muted-foreground">Admin</p>
            </div>
            <Settings className="h-4 w-4 text-muted-foreground" />
          </div>
        </aside>
        <div className="flex-1 bg-background p-6">
          <LayoutDashboard className="h-5 w-5 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            Área de contenido
          </p>
        </div>
      </div>
    </div>
  );
}

function PatternAuth() {
  const [show, setShow] = React.useState(false);
  return (
    <div className="space-y-3">
      <h4 className="font-display font-semibold">
        Pattern F — Form Page (Auth)
      </h4>
      <div className="glass mx-auto max-w-sm rounded-xl p-6">
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessageSquare className="h-5 w-5" />
          </div>
          <p className="font-display text-lg font-semibold">Inicia sesión</p>
          <p className="text-sm text-muted-foreground">Accede a tu workspace</p>
        </div>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="auth-email">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="auth-email"
                className="pl-9"
                placeholder="tu@empresa.com"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="auth-pass">Contraseña</Label>
            <div className="relative">
              <Input
                id="auth-pass"
                type={show ? "text" : "password"}
                className="pr-9"
                placeholder="••••••••"
              />
              <button
                type="button"
                aria-label={show ? "Ocultar contraseña" : "Mostrar contraseña"}
                onClick={() => setShow((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
              >
                {show ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
          <Button className="w-full">Entrar</Button>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <a className="hover:text-foreground" href="#">
              ¿Olvidaste tu contraseña?
            </a>
            <a className="hover:text-foreground" href="#">
              Crear cuenta
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function PatternNavbar() {
  return (
    <div className="space-y-3">
      <h4 className="font-display font-semibold">
        Pattern G — Navbar Responsive
      </h4>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="glass flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <MessageSquare className="h-4 w-4" />
            </div>
            <span className="font-display text-sm font-semibold">
              Agente WhatsApp
            </span>
          </div>
          <nav className="hidden items-center gap-1 sm:flex">
            {["Inbox", "Contactos", "Agente", "Ajustes"].map((l, i) => (
              <a
                key={l}
                href="#"
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors duration-150",
                  i === 0
                    ? "text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {l}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Button
              size="icon"
              variant="ghost"
              className="sm:hidden"
              aria-label="Menú"
            >
              <Menu className="h-5 w-5" />
            </Button>
            <Avatar className="hidden h-8 w-8 sm:block">
              <AvatarFallback className="text-xs">CD</AvatarFallback>
            </Avatar>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Main
// ============================================================
export function ComponentShowcase() {
  return (
    <div className="min-h-screen bg-background">
      <ViewportToggle>
        <div className="mx-auto max-w-5xl px-4 pb-24 sm:px-6">
          {/* Header */}
          <header className="flex flex-wrap items-start justify-between gap-4 py-8">
            <div>
              <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
                <span className="h-2 w-2 rounded-full bg-primary" />
                UI Kit · solo desarrollo
              </div>
              <h1 className="font-display text-4xl font-bold tracking-tight">
                {BRAND.name}
              </h1>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground">
                Fuente de verdad visual. {BRAND.personality}. Audiencia:{" "}
                {BRAND.audience}.
              </p>
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                {BRAND.font} · radius {BRAND.radius} · accent {BRAND.primaryHex}
              </p>
            </div>
            <ThemeToggle />
          </header>

          <HowToPanel hasAgentation={HAS_AGENTATION} />

          {/* Part 1 */}
          <div className="pt-2">
            <p className="font-display text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              Part 1 — Tokens & Components
            </p>
          </div>
          <ColorPalette />
          <Typography />
          <Buttons />
          <FormInputs />
          <Cards />
          <Badges />
          <Alerts />
          <Navigation />
          <LoadingStates />
          <TabsSection />
          <Avatars />
          <ToastFeedback />
          <EmptyStates />

          {/* Part 2 */}
          <div className="border-t border-border pt-10">
            <p className="font-display text-sm font-semibold uppercase tracking-widest text-muted-foreground">
              Part 2 — SaaS Patterns
            </p>
          </div>
          <div className="space-y-12 py-8">
            <PatternKPI />
            <PatternTable />
            <PatternOnboarding />
            <PatternSidebar />
            <PatternAuth />
            <PatternNavbar />
          </div>

          <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
            {BRAND.name} · Component Showcase · Lee COMPONENT_RULES.md antes de
            crear UI.
          </footer>
        </div>
      </ViewportToggle>

      <GlobalFeedbackButton />
    </div>
  );
}
