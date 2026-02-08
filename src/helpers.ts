// Pure data transformation helpers for Runn MCP server.
// No API calls — all functions take pre-fetched data and return shaped results.

// --- Lookup map builders ---

export function buildTeamMap(teams: any[]): Map<number, any> {
  return new Map(teams.map((t) => [t.id, t]));
}

export function buildRoleMap(roles: any[]): Map<number, any> {
  return new Map(roles.map((r) => [r.id, r]));
}

export function buildSkillMap(skills: any[]): Map<number, any> {
  return new Map(skills.map((s) => [s.id, s]));
}

export function buildPersonMap(people: any[]): Map<number, any> {
  return new Map(people.map((p) => [p.id, p]));
}

export function buildClientMap(clients: any[]): Map<number, any> {
  return new Map(clients.map((c) => [c.id, c]));
}

export function buildProjectMap(projects: any[]): Map<number, any> {
  return new Map(projects.map((p) => [p.id, p]));
}

export function personName(p: any): string {
  return `${p.firstName || ""} ${p.lastName || ""}`.trim() || `Person ${p.id}`;
}

// --- Utilization computation ---

export interface UtilizationResult {
  summary: {
    totalPeople: number;
    avgUtilizationPercent: number;
    totalBillableMinutes: number;
    totalNonbillableMinutes: number;
  };
  teams: { name: string; headcount: number; avgUtilization: number }[];
  people: {
    id: number;
    name: string;
    email: string | null;
    team: string | null;
    role: string | null;
    utilizationPercent: number;
    billableMinutes: number;
    nonbillableMinutes: number;
    activeAssignments: number;
  }[];
}

const STANDARD_DAY_MINUTES = 480; // 8 hours

export function computeUtilization(opts: {
  people: any[];
  assignments: any[];
  actuals: any[];
  teams: any[];
  roles: any[];
  teamNameFilter?: string;
  dateRangeDays?: number;
}): UtilizationResult {
  const { people, assignments, actuals, teams, roles, teamNameFilter, dateRangeDays = 20 } = opts;
  const teamMap = buildTeamMap(teams);
  const roleMap = buildRoleMap(roles);

  // Filter people by team name if provided
  let filteredPeople = people;
  if (teamNameFilter) {
    const q = teamNameFilter.trim().toLowerCase();
    const matchingTeamIds = new Set(
      teams.filter((t) => t.name?.toLowerCase().includes(q)).map((t) => t.id)
    );
    filteredPeople = people.filter((p) => {
      const pTeams = p.teamIds || (p.teamId ? [p.teamId] : []);
      return pTeams.some((id: number) => matchingTeamIds.has(id));
    });
  }

  // Group actuals by person
  const actualsByPerson = new Map<number, { billable: number; nonbillable: number }>();
  for (const a of actuals) {
    const pid = a.personId;
    if (!actualsByPerson.has(pid)) actualsByPerson.set(pid, { billable: 0, nonbillable: 0 });
    const entry = actualsByPerson.get(pid)!;
    entry.billable += a.billableMinutes || 0;
    entry.nonbillable += a.nonbillableMinutes || 0;
  }

  // Group assignments by person
  const assignmentsByPerson = new Map<number, any[]>();
  for (const a of assignments) {
    const pid = a.personId;
    if (!assignmentsByPerson.has(pid)) assignmentsByPerson.set(pid, []);
    assignmentsByPerson.get(pid)!.push(a);
  }

  // Available minutes for the period
  const availableMinutes = dateRangeDays * STANDARD_DAY_MINUTES;

  let totalBillable = 0;
  let totalNonbillable = 0;

  const peopleResult = filteredPeople.map((p) => {
    const act = actualsByPerson.get(p.id) || { billable: 0, nonbillable: 0 };
    totalBillable += act.billable;
    totalNonbillable += act.nonbillable;

    const utilization = availableMinutes > 0
      ? round((act.billable / availableMinutes) * 100)
      : 0;

    const teamId = p.teamId || (p.teamIds?.[0]);
    const team = teamId ? teamMap.get(teamId) : null;

    // Resolve role from assignments
    const personAssignments = assignmentsByPerson.get(p.id) || [];
    const primaryRoleId = personAssignments[0]?.roleId;
    const role = primaryRoleId ? roleMap.get(primaryRoleId) : null;

    return {
      id: p.id,
      name: personName(p),
      email: p.email || null,
      team: team?.name || null,
      role: role?.name || p.role || null,
      utilizationPercent: utilization,
      billableMinutes: act.billable,
      nonbillableMinutes: act.nonbillable,
      activeAssignments: personAssignments.length,
    };
  });

  // Compute team summaries
  const teamStats = new Map<string, { total: number; count: number }>();
  for (const p of peopleResult) {
    const teamName = p.team || "Unassigned";
    if (!teamStats.has(teamName)) teamStats.set(teamName, { total: 0, count: 0 });
    const s = teamStats.get(teamName)!;
    s.total += p.utilizationPercent;
    s.count++;
  }

  const teamSummaries = Array.from(teamStats.entries()).map(([name, s]) => ({
    name,
    headcount: s.count,
    avgUtilization: round(s.total / s.count),
  }));

  const avgUtil = peopleResult.length > 0
    ? round(peopleResult.reduce((s, p) => s + p.utilizationPercent, 0) / peopleResult.length)
    : 0;

  return {
    summary: {
      totalPeople: peopleResult.length,
      avgUtilizationPercent: avgUtil,
      totalBillableMinutes: totalBillable,
      totalNonbillableMinutes: totalNonbillable,
    },
    teams: teamSummaries,
    people: peopleResult,
  };
}

// --- Project overview enrichment ---

export interface ProjectOverviewResult {
  totalProjects: number;
  projects: {
    id: number;
    name: string;
    client: string | null;
    team: string | null;
    startDate: string | null;
    endDate: string | null;
    isConfirmed: boolean;
    isTentative: boolean;
    pricingModel: string | null;
    assignmentCount: number;
    assignedPeople: { id: number; name: string; role: string | null }[];
    budgetMinutes: number;
    actualMinutes: number;
    budgetVsActualPercent: number | null;
  }[];
}

const PRICING_MODELS: Record<number, string> = {
  0: "Time & Materials",
  1: "Fixed Price",
  2: "Non-Billable",
};

export function enrichProjectOverview(opts: {
  projects: any[];
  assignments: any[];
  actuals: any[];
  clients: any[];
  teams: any[];
  people: any[];
  roles: any[];
}): ProjectOverviewResult {
  const { projects, assignments, actuals, clients, teams, people, roles } = opts;
  const clientMap = buildClientMap(clients);
  const teamMap = buildTeamMap(teams);
  const personMap = buildPersonMap(people);
  const roleMap = buildRoleMap(roles);

  // Group assignments by project
  const assignmentsByProject = new Map<number, any[]>();
  for (const a of assignments) {
    const pid = a.projectId;
    if (!assignmentsByProject.has(pid)) assignmentsByProject.set(pid, []);
    assignmentsByProject.get(pid)!.push(a);
  }

  // Group actuals by project
  const actualsByProject = new Map<number, number>();
  for (const a of actuals) {
    const pid = a.projectId;
    actualsByProject.set(pid, (actualsByProject.get(pid) || 0) + (a.billableMinutes || 0) + (a.nonbillableMinutes || 0));
  }

  const result = projects.map((p) => {
    const projAssignments = assignmentsByProject.get(p.id) || [];
    const actualMinutes = actualsByProject.get(p.id) || 0;

    // Budget = sum of assignment minutes per day * working days between start/end
    const budgetMinutes = projAssignments.reduce((sum: number, a: any) => {
      const mpd = a.minutesPerDay || 0;
      const days = workingDaysBetween(a.startDate, a.endDate);
      return sum + mpd * days;
    }, 0);

    // Unique people on this project
    const uniquePersonIds = [...new Set(projAssignments.map((a: any) => a.personId))] as number[];
    const assignedPeople = uniquePersonIds.map((pid) => {
      const person = personMap.get(pid);
      const personAssignment = projAssignments.find((a: any) => a.personId === pid);
      const role = personAssignment?.roleId ? roleMap.get(personAssignment.roleId) : null;
      return {
        id: pid,
        name: person ? personName(person) : `Person ${pid}`,
        role: role?.name || null,
      };
    });

    const teamId = p.teamId;
    const team = teamId ? teamMap.get(teamId) : null;

    return {
      id: p.id,
      name: p.name,
      client: clientMap.get(p.clientId)?.name || null,
      team: team?.name || null,
      startDate: p.startDate || null,
      endDate: p.endDate || null,
      isConfirmed: !!p.isConfirmed,
      isTentative: !!p.isTentative,
      pricingModel: PRICING_MODELS[p.pricingModel] || null,
      assignmentCount: projAssignments.length,
      assignedPeople,
      budgetMinutes,
      actualMinutes,
      budgetVsActualPercent: budgetMinutes > 0 ? round((actualMinutes / budgetMinutes) * 100) : null,
    };
  });

  return { totalProjects: result.length, projects: result };
}

// --- Capacity forecast ---

export interface CapacityForecastResult {
  forecastWeeks: number;
  totalPeople: number;
  currentlyUnassigned: number;
  withEndingSoonAssignments: number;
  weeklyBuckets: { weekStart: string; utilization: number; availableCount: number }[];
  forecast: any[];
}

export function computeCapacityForecast(opts: {
  people: any[];
  assignments: any[];
  projects: any[];
  leave: any[];
  teams: any[];
  weeksAhead: number;
}): CapacityForecastResult {
  const { people, assignments, projects, leave, teams, weeksAhead } = opts;
  const projectMap = buildProjectMap(projects);
  const teamMap = buildTeamMap(teams);

  const now = new Date();
  const forecastEnd = new Date(now);
  forecastEnd.setDate(forecastEnd.getDate() + weeksAhead * 7);

  // Leave by person
  const leaveByPerson = new Map<number, any[]>();
  for (const l of leave) {
    const pid = l.personId;
    if (!leaveByPerson.has(pid)) leaveByPerson.set(pid, []);
    leaveByPerson.get(pid)!.push(l);
  }

  const forecast = people.map((p) => {
    const teamId = p.teamId || p.teamIds?.[0];
    const team = teamId ? teamMap.get(teamId) : null;

    const personAssignments = assignments
      .filter((a: any) => a.personId === p.id)
      .map((a: any) => ({
        projectName: projectMap.get(a.projectId)?.name || `Project ${a.projectId}`,
        startDate: a.startDate,
        endDate: a.endDate,
        minutesPerDay: a.minutesPerDay,
      }))
      .filter((a: any) => !a.endDate || new Date(a.endDate) >= now);

    const endingSoon = personAssignments.filter(
      (a: any) => a.endDate && new Date(a.endDate) <= forecastEnd
    );

    const personLeave = (leaveByPerson.get(p.id) || [])
      .filter((l: any) => {
        const end = l.endDate ? new Date(l.endDate) : null;
        return !end || end >= now;
      })
      .map((l: any) => ({
        startDate: l.startDate,
        endDate: l.endDate,
        type: l.leaveType || l.type || "Leave",
      }));

    return {
      name: personName(p),
      id: p.id,
      team: team?.name || null,
      activeAssignments: personAssignments.length,
      endingSoon,
      upcomingLeave: personLeave,
      fullyAvailableAfter: endingSoon.length > 0
        ? endingSoon.reduce((latest: string, a: any) => (a.endDate > latest ? a.endDate : latest), endingSoon[0].endDate)
        : null,
    };
  });

  // Weekly buckets
  const weeklyBuckets = [];
  for (let w = 0; w < weeksAhead; w++) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() + w * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);
    const wsStr = weekStart.toISOString().slice(0, 10);

    let assignedCount = 0;
    for (const p of forecast) {
      const hasAssignment = assignments.some((a: any) => {
        if (a.personId !== p.id) return false;
        const aStart = a.startDate ? new Date(a.startDate) : null;
        const aEnd = a.endDate ? new Date(a.endDate) : null;
        return (!aStart || aStart <= weekEnd) && (!aEnd || aEnd >= weekStart);
      });
      if (hasAssignment) assignedCount++;
    }

    weeklyBuckets.push({
      weekStart: wsStr,
      utilization: people.length > 0 ? round((assignedCount / people.length) * 100) : 0,
      availableCount: people.length - assignedCount,
    });
  }

  const unassigned = forecast.filter((p) => p.activeAssignments === 0);
  const ending = forecast.filter((p) => p.endingSoon.length > 0);

  return {
    forecastWeeks: weeksAhead,
    totalPeople: forecast.length,
    currentlyUnassigned: unassigned.length,
    withEndingSoonAssignments: ending.length,
    weeklyBuckets,
    forecast,
  };
}

// --- Person details enrichment ---

export function enrichPersonDetails(opts: {
  person: any;
  personSkills: any[];
  assignments: any[];
  projects: any[];
  skillMap: Map<number, any>;
  roleMap: Map<number, any>;
  teamMap: Map<number, any>;
}) {
  const { person, personSkills, assignments, projects, skillMap, roleMap, teamMap } = opts;
  const projectMap = buildProjectMap(projects);

  const teamId = person.teamId || person.teamIds?.[0];
  const team = teamId ? teamMap.get(teamId) : null;

  return {
    id: person.id,
    name: personName(person),
    email: person.email || null,
    team: team?.name || null,
    role: person.role || null,
    skills: personSkills.map((s) => ({
      name: skillMap.get(s.skillId)?.name || `Skill ${s.skillId}`,
      level: s.level,
    })),
    assignments: assignments.map((a: any) => ({
      projectName: projectMap.get(a.projectId)?.name || `Project ${a.projectId}`,
      projectId: a.projectId,
      role: a.roleId ? (roleMap.get(a.roleId)?.name || null) : null,
      startDate: a.startDate,
      endDate: a.endDate,
      minutesPerDay: a.minutesPerDay,
    })),
  };
}

// --- Utility ---

function round(n: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function workingDaysBetween(startDate: string | null, endDate: string | null): number {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  let count = 0;
  const d = new Date(start);
  while (d <= end) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}
