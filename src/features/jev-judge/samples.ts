export interface SampleMessage {
  id: string;
  label: string;
  text: string;
}

export const SAMPLE_MESSAGES: SampleMessage[] = [
  { id: "precio", label: "Precio", text: "Hola, vi el anuncio, ¿cuánto cuesta?" },
  { id: "acceso", label: "Soporte", text: "Ya pagué y no me llega el acceso." },
  { id: "baja", label: "Baja", text: "Deja de escribirme." },
  { id: "pago", label: "Cierre", text: "Quiero empezar esta semana, ¿cómo pago?" },
  { id: "ok", label: "Acuse", text: "ok" },
];
