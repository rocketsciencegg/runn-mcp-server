import { describe, it, expect } from "vitest";
import {
  buildTeamMap,
  buildRoleMap,
  buildSkillMap,
  buildPersonMap,
  buildClientMap,
  buildProjectMap,
  personName,
  computeUtilization,
  enrichProjectOverview,
  computeCapacityForecast,
  enrichPersonDetails,
} from "./helpers.js";

// --- Mock data ---

const mockTeams = [
  { id: 1, name: "Engineering" },
  { id: 2, name: "Design" },
];

const mockRoles = [
  { id: 10, name: "Senior Developer", defaultHourlyRate: 150 },
  { id: 11, name: "Designer", defaultHourlyRate: 120 },
];

const mockSkills = [
  { id: 100, name: "TypeScript" },
  { id: 101, name: "React" },
  { id: 102, name: "Figma" },
];

const mockPeople = [
  { id: 1, firstName: "Alice", lastName: "Smith", email: "alice@co.com", teamId: 1 },
  { id: 2, firstName: "Bob", lastName: "Jones", email: "bob@co.com", teamId: 1 },
  { id: 3, firstName: "Carol", lastName: "Lee", email: "carol@co.com", teamId: 2 },
];

const mockClients = [
  { id: 50, name: "Acme Corp" },
  { id: 51, name: "Widget Inc" },
];

const mockProjects = [
  { id: 200, name: "Project Alpha", clientId: 50, teamId: 1, startDate: "2026-01-01", endDate: "2026-06-30", isConfirmed: true, isTentative: false, pricingModel: "tm" },
  { id: 201, name: "Project Beta", clientId: 51, teamId: 2, startDate: "2026-02-01", endDate: "2026-04-30", isConfirmed: false, isTentative: true, pricingModel: "fp" },
];

const mockAssignments = [
  { personId: 1, projectId: 200, roleId: 10, startDate: "2026-01-01", endDate: "2026-06-30", minutesPerDay: 480 },
  { personId: 2, projectId: 200, roleId: 10, startDate: "2026-01-15", endDate: "2026-03-31", minutesPerDay: 240 },
  { personId: 3, projectId: 201, roleId: 11, startDate: "2026-02-01", endDate: "2026-04-30", minutesPerDay: 480 },
];

const mockActuals = [
  { personId: 1, projectId: 200, roleId: 10, billableMinutes: 7200, nonbillableMinutes: 600, date: "2026-02-01" },
  { personId: 2, projectId: 200, roleId: 10, billableMinutes: 3600, nonbillableMinutes: 200, date: "2026-02-01" },
  { personId: 3, projectId: 201, roleId: 11, billableMinutes: 5400, nonbillableMinutes: 1000, date: "2026-02-01" },
];

// --- Map builders ---

describe("map builders", () => {
  it("buildTeamMap creates id->team lookup", () => {
    const m = buildTeamMap(mockTeams);
    expect(m.get(1)?.name).toBe("Engineering");
    expect(m.get(2)?.name).toBe("Design");
    expect(m.size).toBe(2);
  });

  it("buildRoleMap creates id->role lookup", () => {
    const m = buildRoleMap(mockRoles);
    expect(m.get(10)?.name).toBe("Senior Developer");
  });

  it("buildSkillMap creates id->skill lookup", () => {
    const m = buildSkillMap(mockSkills);
    expect(m.get(100)?.name).toBe("TypeScript");
    expect(m.size).toBe(3);
  });

  it("buildPersonMap creates id->person lookup", () => {
    const m = buildPersonMap(mockPeople);
    expect(m.get(1)?.firstName).toBe("Alice");
  });

  it("buildClientMap creates id->client lookup", () => {
    const m = buildClientMap(mockClients);
    expect(m.get(50)?.name).toBe("Acme Corp");
  });

  it("buildProjectMap creates id->project lookup", () => {
    const m = buildProjectMap(mockProjects);
    expect(m.get(200)?.name).toBe("Project Alpha");
  });
});

describe("personName", () => {
  it("returns full name", () => {
    expect(personName({ firstName: "Alice", lastName: "Smith", id: 1 })).toBe("Alice Smith");
  });

  it("handles missing first name", () => {
    expect(personName({ lastName: "Smith", id: 1 })).toBe("Smith");
  });

  it("falls back to Person {id}", () => {
    expect(personName({ id: 42 })).toBe("Person 42");
  });
});

// --- Utilization ---

describe("computeUtilization", () => {
  it("computes utilization percentages", () => {
    const result = computeUtilization({
      people: mockPeople,
      assignments: mockAssignments,
      actuals: mockActuals,
      teams: mockTeams,
      roles: mockRoles,
      dateRangeDays: 20,
    });

    expect(result.summary.totalPeople).toBe(3);
    expect(result.summary.totalBillableMinutes).toBe(16200);
    // Alice: 7200 / (20*480) = 75%
    const alice = result.people.find((p) => p.name === "Alice Smith")!;
    expect(alice.utilizationPercent).toBe(75);
  });

  it("resolves team names", () => {
    const result = computeUtilization({
      people: mockPeople, assignments: mockAssignments, actuals: mockActuals,
      teams: mockTeams, roles: mockRoles,
    });
    const alice = result.people.find((p) => p.name === "Alice Smith")!;
    expect(alice.team).toBe("Engineering");
  });

  it("resolves role names from assignments", () => {
    const result = computeUtilization({
      people: mockPeople, assignments: mockAssignments, actuals: mockActuals,
      teams: mockTeams, roles: mockRoles,
    });
    const alice = result.people.find((p) => p.name === "Alice Smith")!;
    expect(alice.role).toBe("Senior Developer");
  });

  it("filters by team name", () => {
    const result = computeUtilization({
      people: mockPeople, assignments: mockAssignments, actuals: mockActuals,
      teams: mockTeams, roles: mockRoles, teamNameFilter: "design",
    });
    expect(result.summary.totalPeople).toBe(1);
    expect(result.people[0].name).toBe("Carol Lee");
  });

  it("computes team summaries", () => {
    const result = computeUtilization({
      people: mockPeople, assignments: mockAssignments, actuals: mockActuals,
      teams: mockTeams, roles: mockRoles,
    });
    const eng = result.teams.find((t) => t.name === "Engineering")!;
    expect(eng.headcount).toBe(2);
  });

  it("handles empty actuals", () => {
    const result = computeUtilization({
      people: mockPeople, assignments: mockAssignments, actuals: [],
      teams: mockTeams, roles: mockRoles,
    });
    expect(result.summary.totalBillableMinutes).toBe(0);
    expect(result.people[0].utilizationPercent).toBe(0);
  });

  it("handles zero available minutes (dateRangeDays=0)", () => {
    const result = computeUtilization({
      people: mockPeople, assignments: mockAssignments, actuals: mockActuals,
      teams: mockTeams, roles: mockRoles, dateRangeDays: 0,
    });
    expect(result.people[0].utilizationPercent).toBe(0);
  });

  it("handles empty people list", () => {
    const result = computeUtilization({
      people: [], assignments: [], actuals: [],
      teams: mockTeams, roles: mockRoles,
    });
    expect(result.summary.totalPeople).toBe(0);
    expect(result.summary.avgUtilizationPercent).toBe(0);
  });

  it("handles people with teamIds array", () => {
    const people = [{ id: 1, firstName: "Test", lastName: "User", teamIds: [1, 2] }];
    const result = computeUtilization({
      people, assignments: [], actuals: [], teams: mockTeams, roles: [],
      teamNameFilter: "engineering",
    });
    expect(result.summary.totalPeople).toBe(1);
  });
});

// --- Project overview ---

describe("enrichProjectOverview", () => {
  it("resolves client and team names", () => {
    const result = enrichProjectOverview({
      projects: mockProjects, assignments: mockAssignments, actuals: mockActuals,
      clients: mockClients, teams: mockTeams, people: mockPeople, roles: mockRoles,
    });
    expect(result.projects[0].client).toBe("Acme Corp");
    expect(result.projects[0].team).toBe("Engineering");
    expect(result.projects[1].client).toBe("Widget Inc");
  });

  it("resolves assigned people with roles", () => {
    const result = enrichProjectOverview({
      projects: mockProjects, assignments: mockAssignments, actuals: mockActuals,
      clients: mockClients, teams: mockTeams, people: mockPeople, roles: mockRoles,
    });
    const alpha = result.projects[0];
    expect(alpha.assignedPeople).toHaveLength(2);
    expect(alpha.assignedPeople[0].name).toBe("Alice Smith");
    expect(alpha.assignedPeople[0].role).toBe("Senior Developer");
  });

  it("maps pricing model codes", () => {
    const result = enrichProjectOverview({
      projects: mockProjects, assignments: mockAssignments, actuals: mockActuals,
      clients: mockClients, teams: mockTeams, people: mockPeople, roles: mockRoles,
    });
    expect(result.projects[0].pricingModel).toBe("Time & Materials");
    expect(result.projects[1].pricingModel).toBe("Fixed Price");
  });

  it("computes budget vs actual", () => {
    const result = enrichProjectOverview({
      projects: mockProjects, assignments: mockAssignments, actuals: mockActuals,
      clients: mockClients, teams: mockTeams, people: mockPeople, roles: mockRoles,
    });
    const alpha = result.projects[0];
    expect(alpha.actualMinutes).toBe(11600); // (7200+600) + (3600+200)
    expect(alpha.budgetMinutes).toBeGreaterThan(0);
    expect(alpha.budgetVsActualPercent).toBeGreaterThan(0);
  });

  it("handles projects with no assignments", () => {
    const result = enrichProjectOverview({
      projects: [{ id: 999, name: "Empty", clientId: 999 }],
      assignments: [], actuals: [],
      clients: [], teams: [], people: [], roles: [],
    });
    expect(result.projects[0].assignmentCount).toBe(0);
    expect(result.projects[0].budgetVsActualPercent).toBeNull();
  });
});

// --- Capacity forecast ---

describe("computeCapacityForecast", () => {
  it("computes basic forecast", () => {
    const result = computeCapacityForecast({
      people: mockPeople, assignments: mockAssignments,
      projects: mockProjects, leave: [], teams: mockTeams, weeksAhead: 4,
    });
    expect(result.forecastWeeks).toBe(4);
    expect(result.totalPeople).toBe(3);
    expect(result.weeklyBuckets).toHaveLength(4);
  });

  it("resolves team names in forecast", () => {
    const result = computeCapacityForecast({
      people: mockPeople, assignments: mockAssignments,
      projects: mockProjects, leave: [], teams: mockTeams, weeksAhead: 2,
    });
    const alice = result.forecast.find((p: any) => p.name === "Alice Smith");
    expect(alice.team).toBe("Engineering");
  });

  it("includes leave data", () => {
    const leave = [
      { personId: 1, startDate: "2026-02-15", endDate: "2026-02-20", leaveType: "PTO" },
    ];
    const result = computeCapacityForecast({
      people: mockPeople, assignments: mockAssignments,
      projects: mockProjects, leave, teams: mockTeams, weeksAhead: 4,
    });
    const alice = result.forecast.find((p: any) => p.name === "Alice Smith");
    expect(alice.upcomingLeave).toHaveLength(1);
    expect(alice.upcomingLeave[0].type).toBe("PTO");
  });

  it("computes fullyAvailableAfter for ending assignments", () => {
    // Create an assignment ending within 4 weeks
    const soonAssignments = [
      { personId: 1, projectId: 200, roleId: 10, startDate: "2026-01-01", endDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), minutesPerDay: 480 },
    ];
    const result = computeCapacityForecast({
      people: [mockPeople[0]], assignments: soonAssignments,
      projects: mockProjects, leave: [], teams: mockTeams, weeksAhead: 8,
    });
    const alice = result.forecast.find((p: any) => p.name === "Alice Smith");
    expect(alice.endingSoon.length).toBeGreaterThan(0);
    expect(alice.fullyAvailableAfter).toBeTruthy();
  });

  it("identifies unassigned people", () => {
    const result = computeCapacityForecast({
      people: [...mockPeople, { id: 99, firstName: "New", lastName: "Hire", teamId: 1 }],
      assignments: mockAssignments,
      projects: mockProjects, leave: [], teams: mockTeams, weeksAhead: 4,
    });
    expect(result.currentlyUnassigned).toBe(1);
  });

  it("handles empty data", () => {
    const result = computeCapacityForecast({
      people: [], assignments: [], projects: [], leave: [], teams: [], weeksAhead: 2,
    });
    expect(result.totalPeople).toBe(0);
    expect(result.weeklyBuckets).toHaveLength(2);
  });

  it("filters out expired leave", () => {
    const oldLeave = [
      { personId: 1, startDate: "2020-01-01", endDate: "2020-01-10", leaveType: "PTO" },
    ];
    const result = computeCapacityForecast({
      people: [mockPeople[0]], assignments: [],
      projects: [], leave: oldLeave, teams: mockTeams, weeksAhead: 2,
    });
    const alice = result.forecast[0];
    expect(alice.upcomingLeave).toHaveLength(0);
  });

  it("handles leave with no endDate", () => {
    const openLeave = [
      { personId: 1, startDate: "2026-03-01", type: "Sabbatical" },
    ];
    const result = computeCapacityForecast({
      people: [mockPeople[0]], assignments: [],
      projects: [], leave: openLeave, teams: mockTeams, weeksAhead: 2,
    });
    const alice = result.forecast[0];
    expect(alice.upcomingLeave).toHaveLength(1);
    expect(alice.upcomingLeave[0].type).toBe("Sabbatical");
  });

  it("handles assignments with null start/end dates in weekly buckets", () => {
    const openAssignments = [
      { personId: 1, projectId: 200, roleId: 10, startDate: null, endDate: null, minutesPerDay: 480 },
    ];
    const result = computeCapacityForecast({
      people: [mockPeople[0]], assignments: openAssignments,
      projects: mockProjects, leave: [], teams: mockTeams, weeksAhead: 2,
    });
    // With null dates, condition (!aStart || aStart <= weekEnd) && (!aEnd || aEnd >= weekStart) is true
    expect(result.weeklyBuckets[0].availableCount).toBe(0);
  });
});

// --- Person details ---

describe("enrichPersonDetails", () => {
  it("resolves skill names", () => {
    const skillMap = buildSkillMap(mockSkills);
    const result = enrichPersonDetails({
      person: mockPeople[0],
      personSkills: [{ skillId: 100, level: 3 }, { skillId: 101, level: 2 }],
      assignments: [mockAssignments[0]],
      projects: mockProjects,
      skillMap,
      roleMap: buildRoleMap(mockRoles),
      teamMap: buildTeamMap(mockTeams),
    });
    expect(result.skills[0].name).toBe("TypeScript");
    expect(result.skills[0].level).toBe(3);
    expect(result.skills[1].name).toBe("React");
  });

  it("resolves team name", () => {
    const result = enrichPersonDetails({
      person: mockPeople[0],
      personSkills: [],
      assignments: [],
      projects: [],
      skillMap: buildSkillMap(mockSkills),
      roleMap: buildRoleMap(mockRoles),
      teamMap: buildTeamMap(mockTeams),
    });
    expect(result.team).toBe("Engineering");
  });

  it("resolves role names on assignments", () => {
    const result = enrichPersonDetails({
      person: mockPeople[0],
      personSkills: [],
      assignments: [mockAssignments[0]],
      projects: mockProjects,
      skillMap: buildSkillMap(mockSkills),
      roleMap: buildRoleMap(mockRoles),
      teamMap: buildTeamMap(mockTeams),
    });
    expect(result.assignments[0].role).toBe("Senior Developer");
    expect(result.assignments[0].projectName).toBe("Project Alpha");
  });

  it("handles missing skill in map", () => {
    const result = enrichPersonDetails({
      person: mockPeople[0],
      personSkills: [{ skillId: 999, level: 1 }],
      assignments: [],
      projects: [],
      skillMap: buildSkillMap(mockSkills),
      roleMap: buildRoleMap(mockRoles),
      teamMap: buildTeamMap(mockTeams),
    });
    expect(result.skills[0].name).toBe("Skill 999");
  });

  it("handles person with teamIds array", () => {
    const person = { id: 10, firstName: "Dave", lastName: "X", teamIds: [2] };
    const result = enrichPersonDetails({
      person,
      personSkills: [],
      assignments: [],
      projects: [],
      skillMap: new Map(),
      roleMap: new Map(),
      teamMap: buildTeamMap(mockTeams),
    });
    expect(result.team).toBe("Design");
  });
});
