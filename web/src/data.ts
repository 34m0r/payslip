/**
 * Demo company. Fictional, but plausible: a distributed product company headquartered
 * in Lisbon, paying everyone in USDC from one confidential treasury.
 */
export interface Hub { id: string; city: string; country: string; lat: number; lng: number; isHQ?: boolean }
export interface Employee {
  id: string; name: string; role: string; city: string; hub: string;
  lat: number; lng: number; salary: number; // monthly, USDC
}

export const COMPANY = { name: "Atlântica Labs", treasuryHub: "lis" };

export const HUBS: Hub[] = [
  { id: "lis", city: "Lisbon", country: "Portugal", lat: 38.7223, lng: -9.1393, isHQ: true },
  { id: "sao", city: "São Paulo", country: "Brazil", lat: -23.5505, lng: -46.6333 },
  { id: "los", city: "Lagos", country: "Nigeria", lat: 6.5244, lng: 3.3792 },
  { id: "blr", city: "Bengaluru", country: "India", lat: 12.9716, lng: 77.5946 },
  { id: "mex", city: "Mexico City", country: "Mexico", lat: 19.4326, lng: -99.1332 },
];

export const EMPLOYEES: Employee[] = [
  { id: "e01", name: "Inês Carvalho", role: "Chief Financial Officer", city: "Lisbon", hub: "lis", lat: 38.7369, lng: -9.1427, salary: 4200 },
  { id: "e02", name: "Tiago Mendes", role: "Backend engineer", city: "Porto", hub: "lis", lat: 41.1579, lng: -8.6291, salary: 3600 },
  { id: "e03", name: "Clara Duarte", role: "Product designer", city: "Lisbon", hub: "lis", lat: 38.7071, lng: -9.1355, salary: 3300 },
  { id: "e04", name: "Rafael Oliveira", role: "Product manager", city: "São Paulo", hub: "sao", lat: -23.5613, lng: -46.6565, salary: 3900 },
  { id: "e05", name: "Beatriz Lima", role: "Mobile developer", city: "Rio de Janeiro", hub: "sao", lat: -22.9068, lng: -43.1729, salary: 3100 },
  { id: "e06", name: "Joana Prado", role: "Customer support", city: "Curitiba", hub: "sao", lat: -25.4284, lng: -49.2733, salary: 2400 },
  { id: "e07", name: "Adaeze Okafor", role: "Head of operations", city: "Lagos", hub: "los", lat: 6.4541, lng: 3.3947, salary: 3700 },
  { id: "e08", name: "Kwame Mensah", role: "Data analyst", city: "Accra", hub: "los", lat: 5.6037, lng: -0.187, salary: 2900 },
  { id: "e09", name: "Chiamaka Eze", role: "QA engineer", city: "Abuja", hub: "los", lat: 9.0765, lng: 7.3986, salary: 2600 },
  { id: "e10", name: "Priya Raman", role: "Engineering manager", city: "Bengaluru", hub: "blr", lat: 12.9352, lng: 77.6245, salary: 4100 },
  { id: "e11", name: "Arjun Nair", role: "Infrastructure engineer", city: "Kochi", hub: "blr", lat: 9.9312, lng: 76.2673, salary: 3000 },
  { id: "e12", name: "Meera Iyer", role: "Compliance", city: "Chennai", hub: "blr", lat: 13.0827, lng: 80.2707, salary: 2800 },
  { id: "e13", name: "Diego Hernández", role: "Sales", city: "Mexico City", hub: "mex", lat: 19.4194, lng: -99.1455, salary: 3200 },
  { id: "e14", name: "Valeria Ruiz", role: "Marketing", city: "Guadalajara", hub: "mex", lat: 20.6597, lng: -103.3496, salary: 2700 },
];

export const hubOf = (id: string) => HUBS.find((h) => h.id === id)!;
export const treasury = () => hubOf(COMPANY.treasuryHub);

export const usdc = (n: number) =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
